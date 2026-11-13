import type { AddressInfo } from "node:net";
import { MAX_SANDBOX_BODY_BYTES } from "@repopulse/deps/limits";
import type { ParsedLockRequest, ParsedLockResponse } from "@repopulse/deps/sandbox-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxServer, isAuthorized, loadConfig, type SandboxConfig, type SandboxServer } from "./app.js";
import type { ToolVersions } from "./commands.js";

const TOKEN = "a".repeat(64);
const TOOLS: ToolVersions = { npm: "12.2.2", pnpm: "12.18.0", bun: "1.4.4", uv: "0.13.8", poetry: "missing" };
const CONFIG: SandboxConfig = { port: 0, token: TOKEN, tmpRoot: "/tmp", timeoutMs: 60_000, proxy: null };

const REQUEST = {
  packageManager: "NPM",
  workdir: "",
  files: [{ path: "package.json", contentBase64: Buffer.from("{}").toString("base64") }],
  upgrade: [],
  expectLockfile: "package-lock.json",
};
const OK: ParsedLockResponse = { ok: true, lockfile: { path: "package-lock.json", contentBase64: "e30=" } };

let current: SandboxServer | null = null;

async function start(runLock: (req: ParsedLockRequest) => Promise<ParsedLockResponse>) {
  const sandbox = createSandboxServer({ config: CONFIG, tools: TOOLS, runLock: (req) => runLock(req) });
  current = sandbox;
  await new Promise<void>((resolve) => sandbox.server.listen(0, "127.0.0.1", resolve));
  const { port } = sandbox.server.address() as AddressInfo;
  return { sandbox, base: `http://127.0.0.1:${port}` };
}

function post(base: string, body: unknown, token: string | null = TOKEN) {
  return fetch(`${base}/v1/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(async () => {
  await current?.close();
  current = null;
});

describe("loadConfig", () => {
  it("refuses to start without a token", () => {
    expect(() => loadConfig({})).toThrow(/DEPS_SANDBOX_TOKEN/);
    expect(() => loadConfig({ DEPS_SANDBOX_TOKEN: "short" })).toThrow(/DEPS_SANDBOX_TOKEN/);
  });

  it("reads defaults and overrides and rejects invalid PORT, DEPS_SANDBOX_TIMEOUT_MS, and DEPS_EGRESS_PROXY", () => {
    expect(loadConfig({ DEPS_SANDBOX_TOKEN: TOKEN })).toMatchObject({
      port: 3003,
      timeoutMs: 300_000,
      proxy: "http://deps-egress:3128",
    });
    expect(
      loadConfig({ DEPS_SANDBOX_TOKEN: TOKEN, PORT: "4000", DEPS_SANDBOX_TIMEOUT_MS: "5000", DEPS_EGRESS_PROXY: "" }),
    ).toMatchObject({ port: 4000, timeoutMs: 5000, proxy: null });
    for (const badPort of ["-1", "65536", "abc", "3.14"]) {
      expect(() => loadConfig({ DEPS_SANDBOX_TOKEN: TOKEN, PORT: badPort }), badPort).toThrow(/Invalid PORT/);
    }
    for (const badTimeout of ["abc", "999", "3600001"]) {
      expect(() => loadConfig({ DEPS_SANDBOX_TOKEN: TOKEN, DEPS_SANDBOX_TIMEOUT_MS: badTimeout }), badTimeout).toThrow(
        /Invalid DEPS_SANDBOX_TIMEOUT_MS/,
      );
    }
    for (const badProxy of ["socks5://x:1", "https://proxy:3128", "not-a-url"]) {
      expect(() => loadConfig({ DEPS_SANDBOX_TOKEN: TOKEN, DEPS_EGRESS_PROXY: badProxy }), badProxy).toThrow(
        /DEPS_EGRESS_PROXY must be an http:\/\/ URL/,
      );
    }
  });
});

describe("isAuthorized", () => {
  it("compares bearer tokens", () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isAuthorized("Bearer ", TOKEN)).toBe(false);
    expect(isAuthorized(TOKEN, TOKEN)).toBe(false);
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
  });
});

describe("sandbox server", () => {
  it("GET and HEAD /health report 200 without auth, and POST /health returns 405 with Allow: GET", async () => {
    const { base } = await start(async () => OK);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", tools: TOOLS });

    const headRes = await fetch(`${base}/health`, { method: "HEAD" });
    expect(headRes.status).toBe(200);

    const postRes = await fetch(`${base}/health`, { method: "POST" });
    expect(postRes.status).toBe(405);
    expect(postRes.headers.get("allow")).toBe("GET");
  });

  it("rejects requests without the right token", async () => {
    const runLock = vi.fn(async () => OK);
    const { base } = await start(runLock);
    for (const token of [null, "wrong-token-wrong-token"]) {
      const res = await post(base, REQUEST, token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, code: "UNAUTHORIZED", stderrTail: "" });
    }
    expect(runLock).not.toHaveBeenCalled();
  });

  it("validates the body without echoing it back", async () => {
    const { base } = await start(async () => OK);
    let res = await post(base, "{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "BAD_REQUEST" });

    res = await post(base, { ...REQUEST, files: [{ path: "../etc/passwd", contentBase64: "c2VjcmV0" }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { stderrTail: string };
    expect(body).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(body.stderrTail).toBe("invalid request: files.0.path");
    expect(body.stderrTail).not.toContain("passwd");
  });

  it("answers 413 for oversized bodies (with Content-Length and streaming without Content-Length)", async () => {
    const { base } = await start(async () => OK);
    const res = await post(base, "x".repeat(MAX_SANDBOX_BODY_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, code: "TOO_LARGE" });

    const chunk = new Uint8Array(1024 * 1024).fill(120);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_SANDBOX_BODY_BYTES) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    const streamedRes = await fetch(`${base}/v1/lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: stream,
      // @ts-expect-error Node fetch requires duplex: "half" for ReadableStream request bodies
      duplex: "half",
    });
    expect(streamedRes.status).toBe(413);
    expect(await streamedRes.json()).toMatchObject({ ok: false, code: "TOO_LARGE" });
  });

  it("runs one job at a time (503 BUSY) and returns job outcomes as 200", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runLock = vi.fn(async (): Promise<ParsedLockResponse> => {
      await gate;
      return OK;
    });
    const { base } = await start(runLock);

    const first = post(base, REQUEST);
    await vi.waitFor(() => expect(runLock).toHaveBeenCalledTimes(1));
    const second = await post(base, REQUEST);
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("10");
    expect(await second.json()).toMatchObject({ ok: false, code: "BUSY" });

    release();
    const res = await first;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OK);

    runLock.mockImplementationOnce(async () => ({ ok: false, code: "COMMAND_FAILED", stderrTail: "boom" }));
    const failed = await post(base, REQUEST);
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ ok: false, code: "COMMAND_FAILED", stderrTail: "boom" });
  });

  it("aborts the running job on close", async () => {
    let signal: AbortSignal | undefined;
    const sandbox = createSandboxServer({
      config: CONFIG,
      tools: TOOLS,
      runLock: (_req, opts) =>
        new Promise((resolve) => {
          signal = opts.signal;
          opts.signal?.addEventListener("abort", () =>
            resolve({ ok: false, code: "BUSY", stderrTail: "sandbox is shutting down" }),
          );
        }),
    });
    await new Promise<void>((resolve) => sandbox.server.listen(0, "127.0.0.1", resolve));
    const { port } = sandbox.server.address() as AddressInfo;
    const pending = post(`http://127.0.0.1:${port}`, REQUEST);
    await vi.waitFor(() => expect(sandbox.isBusy()).toBe(true));
    await vi.waitFor(() => expect(signal).toBeDefined());
    const closing = sandbox.close();
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "BUSY" });
    await closing;
    expect(sandbox.server.listening).toBe(false);
  });

  it("returns 503 BUSY when shutting down and 500 INTERNAL when runLock throws or returns invalid schema", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { sandbox, base } = await start(async () => {
        throw new Error("boom");
      });
      const internalThrow = await post(base, REQUEST);
      expect(internalThrow.status).toBe(500);
      expect(await internalThrow.json()).toEqual({ ok: false, code: "INTERNAL", stderrTail: "" });

      await sandbox.close();
      current = null;

      const invalidSandbox = createSandboxServer({
        config: CONFIG,
        tools: TOOLS,
        runLock: async () => ({ ok: true, lockfile: { path: "../escape", contentBase64: "e30=" } }) as unknown as ParsedLockResponse,
      });
      current = invalidSandbox;
      await new Promise<void>((resolve) => invalidSandbox.server.listen(0, "127.0.0.1", resolve));
      const { port } = invalidSandbox.server.address() as AddressInfo;
      const base2 = `http://127.0.0.1:${port}`;
      const invalidRes = await post(base2, REQUEST);
      expect(invalidRes.status).toBe(500);
      expect(await invalidRes.json()).toEqual({ ok: false, code: "INTERNAL", stderrTail: "" });

      // Directly invoke the request listener after close() sets shuttingDown = true.
      await invalidSandbox.close();
      current = null;
      const req = new (await import("node:stream")).PassThrough() as unknown as import("node:http").IncomingMessage;
      req.url = "/v1/lock";
      req.method = "POST";
      req.headers = { authorization: `Bearer ${TOKEN}` };
      let status = 0;
      let payload = "";
      const res = {
        headersSent: false,
        writeHead(s: number) {
          status = s;
        },
        end(b?: string) {
          payload = b ?? "";
        },
      } as unknown as import("node:http").ServerResponse;
      invalidSandbox.server.emit("request", req, res);
      req.end();
      await vi.waitFor(() => expect(status).toBe(503));
      expect(JSON.parse(payload)).toEqual({ ok: false, code: "BUSY", stderrTail: "sandbox is shutting down" });
    } finally {
      errSpy.mockRestore();
    }
  });

  it("404s unknown routes", async () => {
    const { base } = await start(async () => OK);
    expect((await fetch(`${base}/v1/other`)).status).toBe(404);
    expect((await fetch(`${base}/v1/lock`)).status).toBe(405);
  });
});
