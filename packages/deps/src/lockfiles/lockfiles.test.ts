import { describe, expect, it } from "vitest";
import { MAX_LOCKFILE_BYTES } from "../limits.js";
import { readBunLock } from "./bun-lock.js";
import { oversizeWarning, splitNameAtVersion } from "./common.js";
import {
  BUN_LOCK,
  PACKAGE_LOCK_V3,
  PNPM_LOCK_V9,
  PNPM_LOCK_V9_MULTI_DOC,
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

describe("lockfile common helpers", () => {
  it("oversizeWarning measures UTF-8 byte length for multi-byte strings > 20 MiB", () => {
    const unitCount = Math.floor(MAX_LOCKFILE_BYTES / 3) + 10;
    const multiByte = "€".repeat(unitCount);
    expect(oversizeWarning(multiByte, "package-lock.json")).toMatch(/package-lock\.json is larger than 20 MiB/);
    const asciiSameLength = "a".repeat(unitCount);
    expect(oversizeWarning(asciiSameLength, "package-lock.json")).toBeNull();
  });

  it("splitNameAtVersion splits scoped and unscoped package descriptors", () => {
    expect(splitNameAtVersion("@scope/pkg@1.2.3")).toEqual({ name: "@scope/pkg", version: "1.2.3" });
    expect(splitNameAtVersion("lodash@4.17.21")).toEqual({ name: "lodash", version: "4.17.21" });
    expect(splitNameAtVersion("@scope/pkg")).toBeNull();
    expect(splitNameAtVersion("lodash")).toBeNull();
    expect(splitNameAtVersion("")).toBeNull();
  });
});

describe("readPackageLock", () => {
  it("reads the root importer and strips a UTF-8 BOM", () => {
    const result = readPackageLock(`\uFEFF${PACKAGE_LOCK_V3}`);
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

  it("strips suffixes and skips non-registry protocols", () => {
    expect(stripPnpmVersionSuffix("1.2.3(react@18.2.0)(react-dom@18.2.0)")).toBe("1.2.3");
    expect(stripPnpmVersionSuffix("1.2.0_react@18.2.0")).toBe("1.2.0");
    for (const protocol of ["link:../ui", "file:../pkg", "workspace:*", "git:github.com/a/b", "http://x/a.tgz", "https://x/a.tgz"]) {
      expect(stripPnpmVersionSuffix(protocol), protocol).toBeNull();
    }
  });

  it("warns when root YAML is not a mapping", () => {
    const res = readPnpmLock("- item1\n- item2\n");
    expect(res.versions.size).toBe(0);
    expect(res.warnings[0]).toMatch(/pnpm-lock\.yaml could not be parsed \(not a YAML mapping\)/);
  });

  it("rejects excessive YAML alias expansion in pnpm-lock.yaml", () => {
    const aliases = Array.from({ length: 120 }, (_, i) => `  pkg-${i}: *a`).join("\n");
    const bomb = `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      a: &a 1.0.0\n${aliases}\n`;
    const res = readPnpmLock(bomb);
    expect(res.versions.size).toBe(0);
    expect(res.warnings[0]).toMatch(/pnpm-lock\.yaml could not be parsed/);
  });

  it("reads multi-document pnpm-lock.yaml (boot/env doc + project doc) without shadowing root importer", () => {
    const root = readPnpmLock(PNPM_LOCK_V9_MULTI_DOC, ".");
    expect(root.warnings).toEqual([]);
    expect(root.formatVersion).toBe("9.0");
    expect(entries(root.versions)).toEqual([["typescript", "5.4.5"]]);

    const web = readPnpmLock(PNPM_LOCK_V9_MULTI_DOC, "apps/web");
    expect(web.warnings).toEqual([]);
    expect(web.formatVersion).toBe("9.0");
    expect(entries(web.versions)).toEqual([
      ["react", "18.2.0"],
      ["react-dom", "18.2.0"],
    ]);
  });

  it("rejects syntax errors, non-mappings, empty streams, too many documents, and alias bombs across multi-doc pnpm-lock.yaml", () => {
    const validDoc = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      a: 1.0.0\n";

    // Syntax error in doc 0 or doc 1
    for (const bad of [`---\n[unclosed\n---\n${validDoc}`, `---\n${validDoc}---\n[unclosed\n`]) {
      const res = readPnpmLock(bad);
      expect(res.versions.size).toBe(0);
      expect(res.formatVersion).toBeNull();
      expect(res.warnings[0]).toMatch(/pnpm-lock\.yaml could not be parsed/);
    }

    // Non-mapping YAML in doc 0 or doc 1
    for (const nonMap of [`---\n- item\n---\n${validDoc}`, `---\n${validDoc}---\n- item\n`]) {
      const res = readPnpmLock(nonMap);
      expect(res.versions.size).toBe(0);
      expect(res.warnings[0]).toMatch(/pnpm-lock\.yaml could not be parsed \(not a YAML mapping\)/);
    }

    // Empty stream
    for (const empty of ["", "# comment only\n"]) {
      const res = readPnpmLock(empty);
      expect(res.versions.size).toBe(0);
      expect(res.warnings[0]).toMatch(/pnpm-lock\.yaml could not be parsed \(not a YAML mapping\)/);
    }

    // Too many documents (> 10)
    const manyDocs = Array.from({ length: 11 }, () => `---\n${validDoc}`).join("\n");
    const manyRes = readPnpmLock(manyDocs);
    expect(manyRes.versions.size).toBe(0);
    expect(manyRes.warnings[0]).toMatch(/too many YAML documents/);

    // Alias bomb in doc 0 followed by valid doc 1
    const aliases = Array.from({ length: 120 }, (_, i) => `  pkg-${i}: *a`).join("\n");
    const doc0Bomb = `---\nlockfileVersion: '9.0'\na: &a 1.0.0\n${aliases}\n---\n${validDoc}`;
    const doc0BombRes = readPnpmLock(doc0Bomb);
    expect(doc0BombRes.versions.size).toBe(0);
    expect(doc0BombRes.warnings[0]).toMatch(/pnpm-lock\.yaml could not be parsed/);
  });
});

describe("readBunLock", () => {
  it("reads JSONC with trailing commas and member-specific resolutions", () => {
    const root = readBunLock(BUN_LOCK, "");
    expect(root.formatVersion).toBe("1");
    expect(entries(root.versions)).toEqual([["typescript", "5.4.5"]]);
    expect(entries(readBunLock(BUN_LOCK, "apps/web").versions)).toEqual([["react", "18.2.0"]]);
  });

  it("skips non-registry protocols, aliases, and returns empty for unknown importer", () => {
    const lock = JSON.stringify({
      lockfileVersion: 1,
      workspaces: {
        "": {
          dependencies: {
            ok: "^1.0.0",
            ws: "workspace:*",
            gh: "github:a/b",
            local: "file:../x",
            aliased: "npm:real-pkg@^2.0.0",
          },
        },
      },
      packages: {
        ok: ["ok@1.2.3"],
        ws: ["ws@workspace:packages/ws"],
        gh: ["gh@github:a/b#123"],
        local: ["local@file:../x"],
        aliased: ["real-pkg@2.1.0"],
      },
    });
    expect(entries(readBunLock(lock, "").versions)).toEqual([["ok", "1.2.3"]]);
    expect(readBunLock(lock, "apps/missing").versions.size).toBe(0);
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

  it("falls back to single version when range spelling differs, but refuses multi-version fallback", () => {
    const singleFallback = readYarnLock(YARN_CLASSIC, [{ name: "lodash", range: "^4.17.0" }]);
    expect(singleFallback.versions.get("lodash")).toBe("4.17.21");

    const multiClassic = `${YARN_CLASSIC}\nlodash@^3.0.0:\n  version "3.10.1"\n`;
    const multiResult = readYarnLock(multiClassic, [{ name: "lodash", range: "^4.17.0" }]);
    expect(multiResult.versions.has("lodash")).toBe(false);
    expect(readYarnLock(multiClassic, [{ name: "lodash", range: "^4.17.21" }]).versions.get("lodash")).toBe("4.17.21");
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

  it("picks the highest PEP 440 version for forked resolutions and skips non-registry sources in uv.lock", () => {
    const forkedUv = `version = 1
[[package]]
name = "urllib3"
version = "2.2.1"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "urllib3"
version = "1.26.18"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "local-pkg"
version = "0.1.0"
source = { editable = "." }

[[package]]
name = "git-pkg"
version = "0.2.0"
source = { git = "https://github.com/a/b.git" }
`;
    const result = readUvLock(forkedUv);
    expect(entries(result.versions)).toEqual([["urllib3", "2.2.1"]]);
  });

  it("reads poetry.lock, skipping non-registry sources and picking the highest version on forks", () => {
    const result = readPoetryLock(POETRY_LOCK);
    expect(result.formatVersion).toBe("2.0");
    expect(entries(result.versions)).toEqual([
      ["django", "5.0.3"],
      ["requests", "2.31.0"],
    ]);

    const forkedPoetry = `[[package]]
name = "urllib3"
version = "1.26.18"

[[package]]
name = "urllib3"
version = "2.2.2"

[[package]]
name = "urllib3"
version = "2.0.7"

[[package]]
name = "dir-pkg"
version = "1.0.0"
[package.source]
type = "directory"
url = "../dir-pkg"

[[package]]
name = "legacy-pkg"
version = "3.0.0"
[package.source]
type = "legacy"
url = "https://private.example.com/simple"
`;
    expect(entries(readPoetryLock(forkedPoetry).versions)).toEqual([["urllib3", "2.2.2"]]);
  });
});

describe("readLockfile", () => {
  it("dispatches by file name and warns on unknown lockfile format", () => {
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
    const unknown = readLockfile({
      packageManager: "NPM",
      lockfilePath: "custom.lock",
      text: "{}",
      importer: "",
      dependencies: [],
    });
    expect(unknown.versions.size).toBe(0);
    expect(unknown.warnings).toEqual(["custom.lock: unknown lockfile format"]);
  });
});
