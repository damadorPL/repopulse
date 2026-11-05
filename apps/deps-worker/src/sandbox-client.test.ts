import { describe, expect, it, vi } from "vitest";
import { MAX_LOCKFILE_BYTES, MAX_SANDBOX_BODY_BYTES, type LockRequest } from "@repopulse/deps";
import {
  createSandboxClient,
  SandboxBusyError,
  SandboxLockError,
  SandboxUnavailableError,
  validateLockfile,
  type LockfileExpectation,
} from "./sandbox-client";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

const REQUEST: LockRequest = {
  packageManager: "NPM",
  workdir: "",
  files: [{ path: "package.json", contentBase64: b64("{}") }],
  upgrade: [{ name: "left-pad", version: "1.3.0" }],
  expectLockfile: "package-lock.json",
};

function respond(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

describe("createSandboxClient().lock", () => {
  it("posts the request with the bearer token and returns the decoded lockfile", async () => {
    const fetch = respond(200, { ok: true, lockfile: { path: "package-lock.json", contentBase64: b64("LOCK") } });
    const client = createSandboxClient({ baseUrl: "http://deps-sandbox:3003/", token: "sandbox-token", fetch });
    expect(await client.lock(REQUEST)).toEqual({ path: "package-lock.json", text: "LOCK" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://deps-sandbox:3003/v1/lock");
    expect(init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer sandbox-token", "Content-Type": "application/json" } });
    expect(JSON.parse(init!.body as string)).toMatchObject({ packageManager: "NPM", lockfileOnly: false, expectLockfile: "package-lock.json" });
  });

  it("maps 503 BUSY to a retryable error", async () => {
    const client = createSandboxClient({ baseUrl: "http://s", token: "t", fetch: respond(503, { ok: false, code: "BUSY", stderrTail: "" }) });
    await expect(client.lock(REQUEST)).rejects.toBeInstanceOf(SandboxBusyError);
  });

  it("maps ok:false to a permanent error that keeps stderr out of the message", async () => {
    const client = createSandboxClient({ baseUrl: "http://s", token: "t", fetch: respond(422, { ok: false, code: "COMMAND_FAILED", stderrTail: "npm ERR! E404" }) });
    const error = await client.lock(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxLockError);
    expect(error).toMatchObject({ code: "COMMAND_FAILED", stderrTail: "npm ERR! E404" });
    expect((error as Error).message).not.toContain("E404");
  });

  it("rejects responses outside the contract", async () => {
    const extra = createSandboxClient({ baseUrl: "http://s", token: "t", fetch: respond(200, { ok: true, lockfile: { path: "../etc/passwd", contentBase64: "" } }) });
    await expect(extra.lock(REQUEST)).rejects.toBeInstanceOf(SandboxUnavailableError);
    const garbage = createSandboxClient({ baseUrl: "http://s", token: "t", fetch: respond(200, "<html>") });
    await expect(garbage.lock(REQUEST)).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("rejects an invalid request before sending it", async () => {
    const fetch = respond(200, {});
    const client = createSandboxClient({ baseUrl: "http://s", token: "t", fetch });
    await expect(client.lock({ ...REQUEST, expectLockfile: "../x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports timeouts and unreachable sandboxes as retryable, without the token, and rethrows caller AbortSignal", async () => {
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    const client = createSandboxClient({ baseUrl: "http://s", token: "very-secret", fetch, timeoutMs: 10 });
    const error = await client.lock(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxUnavailableError);
    expect((error as Error).message).not.toContain("very-secret");

    const controller = new AbortController();
    const abortErr = new DOMException("Worker shutting down", "AbortError");
    controller.abort(abortErr);
    const abortClient = createSandboxClient({
      baseUrl: "http://s",
      token: "t",
      fetch: vi.fn(async () => {
        throw abortErr;
      }),
    });
    await expect(abortClient.lock(REQUEST, controller.signal)).rejects.toBe(abortErr);
  });

  it("rejects oversized requests (> MAX_SANDBOX_BODY_BYTES), oversized responses, and 503 non-JSON responses", async () => {
    const fetch = respond(200, {});
    const client = createSandboxClient({ baseUrl: "http://s", token: "t", fetch });
    const hugeFiles = Array.from({ length: 12 }, (_, i) => ({
      path: `p${i}/package.json`,
      contentBase64: "A".repeat(4 * 1024 * 1024),
    }));
    await expect(client.lock({ ...REQUEST, files: hugeFiles })).rejects.toMatchObject({
      name: "SandboxLockError",
      code: "TOO_LARGE",
    });
    expect(Buffer.byteLength(JSON.stringify({ ...REQUEST, files: hugeFiles }))).toBeGreaterThan(MAX_SANDBOX_BODY_BYTES);
    expect(fetch).not.toHaveBeenCalled();

    // Decoded lockfile > MAX_LOCKFILE_BYTES
    const hugeBase64 = Buffer.alloc(MAX_LOCKFILE_BYTES + 4, 65).toString("base64");
    const oversizeDecoded = createSandboxClient({
      baseUrl: "http://s",
      token: "t",
      fetch: respond(200, { ok: true, lockfile: { path: "package-lock.json", contentBase64: hugeBase64 } }),
    });
    await expect(oversizeDecoded.lock(REQUEST)).rejects.toMatchObject({
      name: "SandboxLockError",
      code: "INVALID_LOCKFILE",
    });

    // 503 with non-JSON or non-contract JSON maps to SandboxBusyError
    const busyHtml = createSandboxClient({ baseUrl: "http://s", token: "t", fetch: respond(503, "Service Unavailable") });
    await expect(busyHtml.lock(REQUEST)).rejects.toBeInstanceOf(SandboxBusyError);
    const busyBadJson = createSandboxClient({ baseUrl: "http://s", token: "t", fetch: respond(503, { status: "busy" }) });
    await expect(busyBadJson.lock(REQUEST)).rejects.toBeInstanceOf(SandboxBusyError);
  });
});

describe("createSandboxClient().health", () => {
  it("returns the tools, or null when unreachable, non-200, or invalid schema", async () => {
    const ok = createSandboxClient({ baseUrl: "http://s", token: "", fetch: respond(200, { status: "ok", tools: { npm: "11.0.0" } }) });
    expect(await ok.health()).toEqual({ status: "ok", tools: { npm: "11.0.0" } });
    const down = createSandboxClient({ baseUrl: "http://s", token: "", fetch: vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))) });
    expect(await down.health()).toBeNull();
    const status500 = createSandboxClient({ baseUrl: "http://s", token: "", fetch: respond(500, { status: "ok", tools: {} }) });
    expect(await status500.health()).toBeNull();
    const badSchema = createSandboxClient({ baseUrl: "http://s", token: "", fetch: respond(200, { status: "wrong" }) });
    expect(await badSchema.health()).toBeNull();
  });
});

describe("validateLockfile", () => {
  const lock = (version: string, lockfileVersion = 3) =>
    JSON.stringify({ lockfileVersion, packages: { "": { dependencies: { "left-pad": "^1.3.0" } }, "node_modules/left-pad": { version } } });
  const expectation: LockfileExpectation = {
    packageManager: "NPM",
    expectLockfile: "package-lock.json",
    inputFormatVersion: "3",
    importers: [{ importer: "", ecosystem: "NPM", dependencies: [{ name: "left-pad", declared: "^1.3.0" }], expected: [{ name: "left-pad", version: "1.3.0" }] }],
  };

  it("accepts a lockfile at the expected path, same format, targets resolved", () => {
    expect(() => validateLockfile({ path: "package-lock.json", text: lock("1.3.0") }, expectation)).not.toThrow();
  });

  it.each([
    ["another path", { path: "apps/x/package-lock.json", text: lock("1.3.0") }, "unexpected path"],
    ["another format", { path: "package-lock.json", text: lock("1.3.0", 2) }, "format changed from 3 to 2"],
    ["an unresolved target", { path: "package-lock.json", text: lock("1.2.0") }, "resolves to 1.2.0"],
    ["an unparsable file", { path: "package-lock.json", text: "{not json" }, "could not be parsed"],
  ])("rejects %s", (_label, result, message) => {
    expect(() => validateLockfile(result, expectation)).toThrow(message);
  });
});
