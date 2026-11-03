/**
 * HTTP surface of `deps-sandbox` (Slice 08 §3.10). Plain `node:http`, no framework.
 *
 *   GET  /health   (no auth) 200 { status: "ok", tools: { npm, pnpm, bun, uv, poetry } }
 *   POST /v1/lock  Authorization: Bearer <DEPS_SANDBOX_TOKEN>, body = LockRequest, response = LockResponse
 *
 * `/v1/lock` always answers with a body matching `lockResponseSchema`. Protocol errors use their HTTP status
 * (400 BAD_REQUEST, 401 UNAUTHORIZED, 413 TOO_LARGE, 503 BUSY, 500 INTERNAL); job outcomes (`ok: true`, and
 * UNSUPPORTED_*, TIMEOUT, COMMAND_FAILED, LOCKFILE_MISSING, an oversized generated lockfile) are 200. Clients should
 * parse the body whatever the status. The request content is never echoed back, except inside the sanitized
 * stderr tail.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import os from "node:os";
import { MAX_SANDBOX_BODY_BYTES } from "@repopulse/deps/limits";
import {
  lockRequestSchema,
  lockResponseSchema,
  type LockErrorCode,
  type ParsedLockResponse,
} from "@repopulse/deps/sandbox-contract";
import type { ToolVersions } from "./commands.js";
import { DEFAULT_EGRESS_PROXY, DEFAULT_TIMEOUT_MS, runLock, type RunLockOptions } from "./run-lock.js";

export const DEFAULT_PORT = 3003;
const MIN_TOKEN_LENGTH = 16;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

export interface SandboxConfig {
  port: number;
  token: string;
  tmpRoot: string;
  timeoutMs: number;
  /** `null` = no proxy (local development only). */
  proxy: string | null;
}

/** Read the configuration. Throws (refusing to start) when `DEPS_SANDBOX_TOKEN` is missing or too short. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const token = env.DEPS_SANDBOX_TOKEN?.trim() ?? "";
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`DEPS_SANDBOX_TOKEN must be set (at least ${MIN_TOKEN_LENGTH} characters)`);
  }

  const port = env.PORT ? Number(env.PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT "${env.PORT}"`);

  const timeoutMs = env.DEPS_SANDBOX_TIMEOUT_MS ? Number(env.DEPS_SANDBOX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid DEPS_SANDBOX_TIMEOUT_MS "${env.DEPS_SANDBOX_TIMEOUT_MS}"`);
  }

  const rawProxy = env.DEPS_EGRESS_PROXY ?? DEFAULT_EGRESS_PROXY;
  const proxy = rawProxy.trim() === "" ? null : rawProxy.trim();
  if (proxy !== null) {
    let url: URL;
    try {
      url = new URL(proxy);
    } catch {
      throw new Error("DEPS_EGRESS_PROXY must be an http:// URL");
    }
    if (url.protocol !== "http:") throw new Error("DEPS_EGRESS_PROXY must be an http:// URL");
  }

  return { port, token, tmpRoot: env.DEPS_SANDBOX_TMP_DIR?.trim() || os.tmpdir(), timeoutMs, proxy };
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time bearer check (hashing first makes the comparison length-independent). */
export function isAuthorized(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  if (!match) return false;
  return timingSafeEqual(sha256(match[1]!), sha256(token));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(json);
}

const STATUS_FOR: Partial<Record<LockErrorCode, number>> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  BUSY: 503,
  INTERNAL: 500,
};

function sendFailure(res: http.ServerResponse, status: number, code: LockErrorCode, stderrTail = "", close = false) {
  const headers: http.OutgoingHttpHeaders = {};
  if (code === "BUSY") headers["Retry-After"] = "10";
  // When the request body was not read, close the connection instead of leaving it half-consumed.
  if (close) headers.Connection = "close";
  sendJson(res, status, { ok: false, code, stderrTail } satisfies ParsedLockResponse, headers);
}

/** Bodies past this are cut off (socket destroyed) instead of drained before an error answer. */
const DRAIN_LIMIT_BYTES = 2 * MAX_SANDBOX_BODY_BYTES;

type BodyResult = { kind: "ok"; body: Buffer } | { kind: "too-large" } | { kind: "aborted" };

/**
 * Read the body, keeping at most `keep` bytes. Anything beyond is drained and dropped (so the client reads the
 * error answer instead of a connection reset) up to {@link DRAIN_LIMIT_BYTES}, past which the socket is destroyed.
 */
function readBody(req: http.IncomingMessage, keep: number): Promise<BodyResult> {
  return new Promise<BodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: BodyResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > DRAIN_LIMIT_BYTES) {
        req.destroy();
        settle({ kind: "aborted" });
      } else if (size <= keep) {
        chunks.push(chunk);
      }
    });
    req.on("end", () => settle(size > keep ? { kind: "too-large" } : { kind: "ok", body: Buffer.concat(chunks, size) }));
    req.on("error", () => settle({ kind: "aborted" }));
    req.on("close", () => settle({ kind: "aborted" }));
  });
}

/** Answer an error before reading the body: drain it first (bounded) so the client sees the answer. */
async function rejectEarly(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  code: LockErrorCode,
  stderrTail = "",
): Promise<void> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > DRAIN_LIMIT_BYTES) {
    sendFailure(res, status, code, stderrTail, true);
    return;
  }
  const drained = await readBody(req, 0);
  if (drained.kind !== "aborted") sendFailure(res, status, code, stderrTail);
}

/** zod issue locations only (no messages, no values): never echoes request content. */
function describeIssues(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const paths = [...new Set(issues.map((issue) => issue.path.map(String).join(".") || "(root)"))];
  return `invalid request: ${paths.slice(0, 10).join(", ")}`.slice(0, 500);
}

export interface SandboxServerOptions {
  config: SandboxConfig;
  tools: ToolVersions;
  /** Injected in tests; defaults to the real job runner. */
  runLock?: (request: Parameters<typeof runLock>[0], options: RunLockOptions) => Promise<ParsedLockResponse>;
  /** Extra runner options (tests). */
  runOptions?: Partial<RunLockOptions>;
}

export interface SandboxServer {
  server: http.Server;
  isBusy: () => boolean;
  /** Stop accepting requests, abort the running job (it answers BUSY) and wait for it to clean up. */
  close: () => Promise<void>;
}

export function createSandboxServer(options: SandboxServerOptions): SandboxServer {
  const { config, tools } = options;
  const run = options.runLock ?? runLock;
  let busy = false;
  let shuttingDown = false;
  let current: { abort: AbortController; done: Promise<void> } | null = null;

  async function handleLock(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!isAuthorized(req.headers.authorization, config.token)) {
      await rejectEarly(req, res, 401, "UNAUTHORIZED");
      return;
    }
    if (shuttingDown) {
      await rejectEarly(req, res, 503, "BUSY", "sandbox is shutting down");
      return;
    }
    if (busy) {
      await rejectEarly(req, res, 503, "BUSY", "another job is running");
      return;
    }
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > MAX_SANDBOX_BODY_BYTES) {
      await rejectEarly(req, res, 413, "TOO_LARGE", "request body exceeds the size cap");
      return;
    }

    busy = true;
    const abort = new AbortController();
    let release!: () => void;
    current = { abort, done: new Promise<void>((resolve) => (release = resolve)) };
    try {
      const read = await readBody(req, MAX_SANDBOX_BODY_BYTES);
      if (read.kind === "aborted") return; // client went away
      if (read.kind === "too-large") {
        sendFailure(res, 413, "TOO_LARGE", "request body exceeds the size cap");
        return;
      }
      const body = read.body;

      let json: unknown;
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        sendFailure(res, 400, "BAD_REQUEST", "request body is not valid JSON");
        return;
      }
      const parsed = lockRequestSchema.safeParse(json);
      if (!parsed.success) {
        sendFailure(res, 400, "BAD_REQUEST", describeIssues(parsed.error.issues));
        return;
      }

      const started = Date.now();
      const result = await run(parsed.data, {
        tmpRoot: config.tmpRoot,
        timeoutMs: config.timeoutMs,
        proxy: config.proxy,
        tools,
        signal: abort.signal,
        ...options.runOptions,
      });
      const checked = lockResponseSchema.safeParse(result);
      if (!checked.success) {
        console.error("[deps-sandbox] job produced an invalid response");
        sendFailure(res, 500, "INTERNAL");
        return;
      }
      const response = checked.data;
      console.log(
        `[deps-sandbox] ${parsed.data.packageManager} job ${response.ok ? "ok" : response.code} in ${Date.now() - started}ms`,
      );
      sendJson(res, response.ok ? 200 : (STATUS_FOR[response.code] ?? 200), response);
    } finally {
      busy = false;
      current = null;
      release();
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/health") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { status: "error" }, { Allow: "GET" });
        return;
      }
      sendJson(res, 200, { status: "ok", tools });
      return;
    }
    if (pathname === "/v1/lock") {
      if (req.method !== "POST") {
        sendFailure(res, 405, "BAD_REQUEST", "method not allowed", true);
        return;
      }
      await handleLock(req, res);
      return;
    }
    sendFailure(res, 404, "BAD_REQUEST", "not found", true);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error(`[deps-sandbox] unexpected handler error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendFailure(res, 500, "INTERNAL", "", true);
      else res.end();
    });
  });
  // Uploads must arrive quickly; the response may take up to the job timeout (server.timeout stays 0).
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  const close = async () => {
    shuttingDown = true;
    const closed = new Promise<void>((resolve) => {
      if (!server.listening) resolve();
      else server.close(() => resolve());
    });
    server.closeIdleConnections();
    const job = current;
    if (job) {
      job.abort.abort();
      await job.done;
      // Let the BUSY answer flush, then drop the keep-alive socket it used.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    server.closeAllConnections();
    await closed;
  };

  return { server, isBusy: () => busy, close };
}
