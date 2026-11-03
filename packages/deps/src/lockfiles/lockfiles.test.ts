import { describe, expect, it } from "vitest";
import { MAX_LOCKFILE_BYTES } from "../limits.js";
import { readBunLock } from "./bun-lock.js";
import {
  BUN_LOCK,
  PACKAGE_LOCK_V3,
  PNPM_LOCK_V9,
  POETRY_LOCK,
  UV_LOCK,
  YARN_BERRY,
  YARN_CLASSIC,
} from "./fixtures.test-data.js";
import { readLockfile } from "./index.js";
import { readPackageLock } from "./package-lock.js";
import { readPnpmLock, stripPnpmVersionSuffix } from "./pnpm-lock.js";
import { readPoetryLock } from "./poetry-lock.js";
import { readUvLock } from "./uv-lock.js";
import { readYarnLock } from "./yarn-lock.js";

const entries = (map: Map<string, string>): Array<[string, string]> => [...map].sort((a, b) => (a[0] < b[0] ? -1 : 1));

describe("readPackageLock", () => {
  it("reads the root importer", () => {
    const result = readPackageLock(PACKAGE_LOCK_V3);
    expect(result.formatVersion).toBe("3");
    expect(entries(result.versions)).toEqual([
      ["react", "18.2.0"],
      ["typescript", "5.4.5"],
    ]);
  });

  it("reads a workspace member (nested first, then hoisted; links skipped)", () => {
    expect(entries(readPackageLock(PACKAGE_LOCK_V3, "apps/web").versions)).toEqual([
      ["lodash", "4.17.21"],
      ["react", "17.0.2"],
    ]);
  });

  it("reads lockfileVersion 1", () => {
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0" }, b: { version: "file:../b" } } });
    const result = readPackageLock(v1);
    expect(result.formatVersion).toBe("1");
    expect(entries(result.versions)).toEqual([["a", "1.0.0"]]);
  });

  it("returns an empty map and a warning on parse failure", () => {
    const result = readPackageLock("{ broken");
    expect(result.versions.size).toBe(0);
    expect(result.warnings[0]).toMatch(/could not be parsed/);
  });

  it("returns an empty map and a warning when oversize", () => {
    const huge = " ".repeat(MAX_LOCKFILE_BYTES + 1);
    const result = readPackageLock(huge);
    expect(result.versions.size).toBe(0);
    expect(result.warnings[0]).toMatch(/larger than 20 MiB/);
  });
});

describe("readPnpmLock", () => {
  it("reads importers and strips peer suffixes", () => {
    const root = readPnpmLock(PNPM_LOCK_V9, ".");
    expect(root.formatVersion).toBe("9.0");
    expect(entries(root.versions)).toEqual([["typescript", "5.4.5"]]);
    expect(entries(readPnpmLock(PNPM_LOCK_V9, "apps/web").versions)).toEqual([
      ["react", "18.2.0"],
      ["react-dom", "18.2.0"],
    ]);
  });

  it("reads the single-project layout", () => {
    const old = "lockfileVersion: 5.4\nspecifiers:\n  a: ^1.0.0\ndependencies:\n  a: 1.2.0_b@2.0.0\n";
    expect(entries(readPnpmLock(old).versions)).toEqual([["a", "1.2.0"]]);
  });

  it("strips suffixes", () => {
    expect(stripPnpmVersionSuffix("1.2.3(react@18.2.0)(react-dom@18.2.0)")).toBe("1.2.3");
    expect(stripPnpmVersionSuffix("link:../ui")).toBeNull();
  });
});

describe("readBunLock", () => {
  it("reads JSONC with trailing commas and member-specific resolutions", () => {
    const root = readBunLock(BUN_LOCK, "");
    expect(root.formatVersion).toBe("1");
    expect(entries(root.versions)).toEqual([["typescript", "5.4.5"]]);
    expect(entries(readBunLock(BUN_LOCK, "apps/web").versions)).toEqual([["react", "18.2.0"]]);
  });

  it("warns on invalid text", () => {
    expect(readBunLock("{ nope ").warnings).toHaveLength(1);
  });
});

describe("readYarnLock", () => {
  const declared = [
    { name: "@babel/core", range: "^7.1.0" },
    { name: "lodash", range: "^4.17.21" },
    { name: "missing", range: "^1.0.0" },
  ];

  it("reads classic lockfiles", () => {
    const result = readYarnLock(YARN_CLASSIC, declared);
    expect(result.formatVersion).toBe("classic");
    expect(entries(result.versions)).toEqual([
      ["@babel/core", "7.24.0"],
      ["lodash", "4.17.21"],
    ]);
  });

  it("reads Berry lockfiles", () => {
    const result = readYarnLock(YARN_BERRY, declared);
    expect(result.formatVersion).toBe("berry/8");
    expect(entries(result.versions)).toEqual([
      ["@babel/core", "7.24.0"],
      ["lodash", "4.17.21"],
    ]);
  });
});

describe("readUvLock / readPoetryLock", () => {
  it("reads uv.lock registry packages", () => {
    const result = readUvLock(UV_LOCK);
    expect(result.formatVersion).toBe("1/2");
    expect(entries(result.versions)).toEqual([
      ["httpx", "0.27.0"],
      ["rich", "13.7.1"],
    ]);
    expect(entries(readUvLock(UV_LOCK, ["HTTPX"]).versions)).toEqual([["httpx", "0.27.0"]]);
  });

  it("reads poetry.lock, skipping git sources", () => {
    const result = readPoetryLock(POETRY_LOCK);
    expect(result.formatVersion).toBe("2.0");
    expect(entries(result.versions)).toEqual([
      ["django", "5.0.3"],
      ["requests", "2.31.0"],
    ]);
  });
});

describe("readLockfile", () => {
  it("dispatches by file name", () => {
    const pnpm = readLockfile({
      packageManager: "PNPM",
      lockfilePath: "pnpm-lock.yaml",
      text: PNPM_LOCK_V9,
      importer: "",
      dependencies: [],
    });
    expect(pnpm.versions.get("typescript")).toBe("5.4.5");
    const lockb = readLockfile({ packageManager: "BUN", lockfilePath: "bun.lockb", text: "", importer: "", dependencies: [] });
    expect(lockb.warnings[0]).toMatch(/bun.lockb is binary/);
    const pins = readLockfile({
      packageManager: "PIP_TOOLS",
      lockfilePath: "requirements.txt",
      text: "django==5.0.3\n",
      importer: "",
      dependencies: [],
    });
    expect(pins.versions.get("django")).toBe("5.0.3");
    const yarn = readLockfile({
      packageManager: "YARN",
      lockfilePath: "yarn.lock",
      text: YARN_CLASSIC,
      importer: "",
      dependencies: [{ name: "lodash", declared: "^4.17.21" }],
    });
    expect(yarn.versions.get("lodash")).toBe("4.17.21");
  });
});
