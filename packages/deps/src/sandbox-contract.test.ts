import { describe, expect, it } from "vitest";
import { MAX_SANDBOX_FILES } from "./limits.js";
import { lockRequestSchema, lockResponseSchema, sandboxFileSchema, sandboxHealthSchema } from "./sandbox-contract.js";

const VALID_FILE = { path: "package.json", contentBase64: "e30=" };
const VALID_REQUEST = {
  packageManager: "NPM" as const,
  workdir: "",
  files: [VALID_FILE],
  upgrade: [{ name: "react", version: "19.0.0" }],
  expectLockfile: "package-lock.json",
};

describe("lockRequestSchema", () => {
  it("accepts a valid request and defaults lockfileOnly to false", () => {
    expect(lockRequestSchema.parse(VALID_REQUEST)).toEqual({
      ...VALID_REQUEST,
      lockfileOnly: false,
    });
    expect(lockRequestSchema.parse({ ...VALID_REQUEST, workdir: "apps/web", expectLockfile: "apps/web/package-lock.json" })).toMatchObject({
      workdir: "apps/web",
    });
  });

  it("rejects path traversal, drives, backslashes, leading/trailing slashes and NUL in relativePath and workdir", () => {
    const badPaths = [
      "",
      "/package.json",
      "apps\\package.json",
      "apps\0/package.json",
      "C:package.json",
      "c:/package.json",
      "..",
      "../package.json",
      "apps/../package.json",
      ".",
      "./package.json",
      "apps/./package.json",
      "apps//package.json",
      "apps/package.json/",
      "a".repeat(1025),
    ];
    for (const bad of badPaths) {
      expect(sandboxFileSchema.safeParse({ path: bad, contentBase64: "" }).success, `file.path=${JSON.stringify(bad)}`).toBe(false);
      expect(lockRequestSchema.safeParse({ ...VALID_REQUEST, expectLockfile: bad }).success, `expectLockfile=${JSON.stringify(bad)}`).toBe(false);
    }

    for (const badWorkdir of badPaths.filter((p) => p !== "")) {
      expect(lockRequestSchema.safeParse({ ...VALID_REQUEST, workdir: badWorkdir }).success, `workdir=${JSON.stringify(badWorkdir)}`).toBe(false);
    }
  });

  it("enforces array and string length bounds on files and upgrade", () => {
    expect(lockRequestSchema.safeParse({ ...VALID_REQUEST, files: [] }).success).toBe(false);
    const tooManyFiles = Array.from({ length: MAX_SANDBOX_FILES + 1 }, (_, i) => ({ path: `p${i}/package.json`, contentBase64: "" }));
    expect(lockRequestSchema.safeParse({ ...VALID_REQUEST, files: tooManyFiles }).success).toBe(false);

    const tooManyUpgrades = Array.from({ length: 1001 }, (_, i) => ({ name: `pkg-${i}`, version: "1.0.0" }));
    expect(lockRequestSchema.safeParse({ ...VALID_REQUEST, upgrade: tooManyUpgrades }).success).toBe(false);
    expect(lockRequestSchema.safeParse({ ...VALID_REQUEST, upgrade: [{ name: "", version: "1.0.0" }] }).success).toBe(false);
    expect(lockRequestSchema.safeParse({ ...VALID_REQUEST, upgrade: [{ name: "a".repeat(215), version: "1.0.0" }] }).success).toBe(false);
    expect(lockRequestSchema.safeParse({ ...VALID_REQUEST, upgrade: [{ name: "a", version: "" }] }).success).toBe(false);
    expect(lockRequestSchema.safeParse({ ...VALID_REQUEST, upgrade: [{ name: "a", version: "1".repeat(129) }] }).success).toBe(false);
  });

  it("rejects unknown keys via .strict()", () => {
    expect(lockRequestSchema.safeParse({ ...VALID_REQUEST, token: "secret" }).success).toBe(false);
    expect(lockRequestSchema.safeParse({ ...VALID_REQUEST, files: [{ ...VALID_FILE, extra: 1 }] }).success).toBe(false);
    expect(lockRequestSchema.safeParse({ ...VALID_REQUEST, upgrade: [{ name: "a", version: "1.0.0", extra: true }] }).success).toBe(false);
  });
});

describe("lockResponseSchema and sandboxHealthSchema", () => {
  it("validates ok:true and ok:false responses and rejects unknown keys or invalid paths", () => {
    expect(lockResponseSchema.parse({ ok: true, lockfile: VALID_FILE })).toEqual({ ok: true, lockfile: VALID_FILE });
    expect(lockResponseSchema.parse({ ok: false, code: "BUSY" })).toEqual({ ok: false, code: "BUSY", stderrTail: "" });

    expect(lockResponseSchema.safeParse({ ok: true, lockfile: { path: "../etc/passwd", contentBase64: "" } }).success).toBe(false);
    expect(lockResponseSchema.safeParse({ ok: true, lockfile: VALID_FILE, extra: 1 }).success).toBe(false);
    expect(lockResponseSchema.safeParse({ ok: false, code: "BUSY", extra: 1 }).success).toBe(false);
    expect(lockResponseSchema.safeParse({ ok: false, code: "BUSY", stderrTail: "x".repeat(4097) }).success).toBe(false);
    expect(lockResponseSchema.safeParse({ ok: false, code: "UNKNOWN_CODE" }).success).toBe(false);

    expect(sandboxHealthSchema.parse({ status: "ok", tools: { npm: "11.0.0" } })).toEqual({
      status: "ok",
      tools: { npm: "11.0.0" },
    });
  });
});
