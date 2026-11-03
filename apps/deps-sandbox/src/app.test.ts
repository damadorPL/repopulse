import type { AddressInfo } from "node:net";
import { MAX_SANDBOX_BODY_BYTES } from "@repopulse/deps/limits";
import type { ParsedLockRequest, ParsedLockResponse } from "@repopulse/deps/sandbox-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandboxServer, isAuthorized, loadConfig, type SandboxConfig, type SandboxServer } from "./app.js";
import type { ToolVersions } from "./commands.js";

const TOKEN = "a".repeat(64);
const TOOLS: ToolVersions = { npm: "12.2.1", pnpm: "12.14.0", bun: "1.4.3", uv: "0.13.1", poetry: "missing" };
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

  it("reads defaults and overrides", () => {
    expect(loadConfig({ DEPS_SANDBOX_TOKEN: TOKEN })).toMatchObject({
      port: 3003,
      timeoutMs: 300_000,
      proxy: "http://deps-egress:3128",
    });
    expect(
      loadConfig({ DEPS_SANDBOX_TOKEN: TOKEN, PORT: "4000", DEPS_SANDBOX_TIMEOUT_MS: "5000", DEPS_EGRESS_PROXY: "" }),
    ).toMatchObject({ port: 4000, timeoutMs: 5000, proxy: null });
    expect(() => loadConfig({ DEPS_SANDBOX_TOKEN: TOKEN, DEPS_SANDBOX_TIMEOUT_MS: "abc" })).toThrow();
    expect(() => loadConfig({ DEPS_SANDBOX_TOKEN: TOKEN, DEPS_EGRESS_PROXY: "socks5://x:1" })).toThrow();
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
  it("GET /health reports the tool versions without auth", async () => {
    const { base } = await start(async () => OK);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", tools: TOOLS });
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

  it("answers 413 for oversized bodies", async () => {
    const { base } = await start(async () => OK);
    const res = await post(base, "x".repeat(MAX_SANDBOX_BODY_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, code: "TOO_LARGE" });
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

  it("404s unknown routes", async () => {
    const { base } = await start(async () => OK);
    expect((await fetch(`${base}/v1/other`)).status).toBe(404);
    expect((await fetch(`${base}/v1/lock`)).status).toBe(405);
  });
});
