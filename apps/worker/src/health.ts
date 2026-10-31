import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { prisma } from "@repopulse/db";

/**
 * Lightweight healthcheck HTTP server used by Coolify / docker-compose
 * (`wget -qO- http://localhost:3001/health`).
 *
 * GET /health
 *   200 { status: "ok",    checks: { database: "ok", redis: "ok" | "skipped" }, timestamp }
 *   503 { status: "error", checks: { database: "ok" | "error", redis: "ok" | "error" | "skipped" }, timestamp }
 *
 * Error details are logged server-side only; the response never contains
 * connection strings, credentials or driver error messages.
 */

export type CheckResult = "ok" | "error" | "skipped";

export interface HealthReport {
  status: "ok" | "error";
  checks: {
    database: CheckResult;
    redis: CheckResult;
  };
  timestamp: string;
}

const DEFAULT_HEALTH_PORT = 3001;
const DB_TIMEOUT_MS = 3_000;
const REDIS_TIMEOUT_MS = 2_000;

/** Reject if `promise` does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(err: unknown): string {
  // Collapse Prisma's multi-line messages into a single log line.
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

export async function checkDatabase(): Promise<CheckResult> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, DB_TIMEOUT_MS, "database ping");
    return "ok";
  } catch (err) {
    console.error(`[health] database check failed: ${errorMessage(err)}`);
    return "error";
  }
}

/** Encode a command as a RESP array of bulk strings. */
function encodeCommand(args: string[]): string {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    out += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`;
  }
  return out;
}

/**
 * Minimal Redis PING over a raw socket (no client dependency).
 * Supports `redis://[[user]:pass@]host[:port]` and `rediss://` (TLS).
 * Sends AUTH first when the URL carries a password, then expects `+PONG`.
 */
export function pingRedis(redisUrl: string, timeoutMs = REDIS_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(redisUrl);
    } catch {
      reject(new Error("REDIS_URL is not a valid URL"));
      return;
    }
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
      reject(new Error(`unsupported REDIS_URL protocol "${url.protocol}"`));
      return;
    }

    const host = url.hostname.replace(/^\[|\]$/g, "") || "localhost";
    const port = url.port ? Number(url.port) : 6379;
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);

    const commands: string[][] = [];
    if (password) {
      commands.push(username ? ["AUTH", username, password] : ["AUTH", password]);
    }
    commands.push(["PING"]);
    const payload = commands.map(encodeCommand).join("");

    let settled = false;
    let buffer = "";
    const replies: string[] = [];

    const socket: net.Socket =
      url.protocol === "rediss:"
        ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
        : net.connect({ host, port });

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(
      () => finish(new Error(`redis ping timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    socket.setNoDelay(true);
    socket.once(url.protocol === "rediss:" ? "secureConnect" : "connect", () => {
      socket.write(payload);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\r\n")) !== -1) {
        replies.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
      if (replies.length < commands.length) return;

      if (password) {
        const authReply = replies[0] ?? "";
        if (!authReply.startsWith("+OK")) {
          // Redis error replies never echo the password back.
          finish(new Error(`redis AUTH failed: ${authReply}`));
          return;
        }
      }
      const pingReply = replies[commands.length - 1] ?? "";
      if (pingReply === "+PONG") finish();
      else finish(new Error(`unexpected redis PING reply: ${pingReply}`));
    });
    socket.on("error", (err) => finish(new Error(`redis connection error: ${err.message}`)));
    socket.on("close", () => finish(new Error("redis connection closed before reply")));
  });
}

export async function checkRedis(): Promise<CheckResult> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return "skipped";
  try {
    await pingRedis(redisUrl);
    return "ok";
  } catch (err) {
    console.error(`[health] redis check failed: ${errorMessage(err)}`);
    return "error";
  }
}

export async function getHealthReport(): Promise<HealthReport> {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const healthy = database !== "error" && redis !== "error";
  return {
    status: healthy ? "ok" : "error",
    checks: { database, redis },
    timestamp: new Date().toISOString(),
  };
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
  });
  res.end(json);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && path === "/health") {
    const report = await getHealthReport();
    sendJson(res, report.status === "ok" ? 200 : 503, report);
    return;
  }
  sendJson(res, 404, { status: "not_found" });
}

export interface HealthServer {
  server: http.Server;
  port: number;
  /** Stop accepting connections, drop idle keep-alive sockets and wait for close. */
  close: () => Promise<void>;
}

export function resolveHealthPort(): number {
  const raw = process.env.HEALTH_PORT;
  if (!raw) return DEFAULT_HEALTH_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid HEALTH_PORT "${raw}"`);
  }
  return port;
}

/**
 * Start the health server. Resolves once the server is listening.
 */
export function startHealthServer(port = resolveHealthPort()): Promise<HealthServer> {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      console.error(`[health] unexpected handler error: ${errorMessage(err)}`);
      if (!res.headersSent) {
        sendJson(res, 503, { status: "error", timestamp: new Date().toISOString() });
      } else {
        res.end();
      }
    });
  });
  // Health checks are short-lived; avoid holding sockets open during shutdown.
  server.keepAliveTimeout = 1_000;

  const close = () =>
    new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeIdleConnections();
    });

  return new Promise<HealthServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({ server, port: boundPort, close });
    });
  });
}
