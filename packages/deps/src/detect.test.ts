import { describe, expect, it } from "vitest";
import {
  BUN_LOCKB_WARNING,
  detectManifests,
  detectManifestsWithReader,
  resolveManifestGroups,
  YARN_WARNING,
  type DetectedManifest,
  type RepoTreeEntry,
} from "./detect.js";
import {
  BUN_LOCK,
  PACKAGE_LOCK_V3,
  PNPM_LOCK_V9,
  POETRY_LOCK,
  UV_LOCK,
  YARN_BERRY,
  YARN_CLASSIC,
} from "./lockfiles/fixtures.test-data.js";
import { readLockfile } from "./lockfiles/index.js";
import { parsePackageJson } from "./manifests/package-json.js";
import { parsePyproject } from "./manifests/pyproject.js";
import { parseRequirements } from "./manifests/requirements.js";
import type { ParsedDependency } from "./types.js";

function treeOf(files: Record<string, string>, extra: string[] = []): RepoTreeEntry[] {
  const dirs = new Set<string>();
  for (const path of [...Object.keys(files), ...extra]) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [
    ...[...dirs].map((path) => ({ path, type: "tree" as const, sha: `t-${path}` })),
    ...[...Object.keys(files), ...extra].map((path) => ({ path, type: "blob" as const, sha: `sha-${path}`, size: 10 })),
  ];
}

interface Row {
  name: string;
  kind: string;
  declared: string;
  current: string | null;
  supported: boolean;
}

/** End-to-end at the parser level: detect → parse → read lockfile, like the scan processor. */
async function scan(files: Record<string, string>, extra: string[] = []) {
  const { manifests, warnings } = await detectManifestsWithReader(treeOf(files, extra), async (path) => files[path] ?? null);
  const result: Array<{ manifest: DetectedManifest; rows: Row[]; formatVersion: string | null }> = [];
  for (const manifest of manifests) {
    const text = files[manifest.path] ?? "";
    let dependencies: ParsedDependency[];
    let pins = new Map<string, string>();
    if (manifest.format === "package.json") dependencies = parsePackageJson(text, manifest.path).dependencies;
    else if (manifest.format === "pyproject") dependencies = parsePyproject(text, manifest.path).dependencies;
    else {
      const parsed = parseRequirements(text, manifest.path);
      dependencies = parsed.dependencies;
      for (const d of parsed.dependencies) if (d.pinnedVersion) pins.set(d.name, d.pinnedVersion);
    }
    let formatVersion: string | null = null;
    if (manifest.lockfilePath) {
      const lock = readLockfile({
        packageManager: manifest.packageManager,
        lockfilePath: manifest.lockfilePath,
        text: files[manifest.lockfilePath] ?? "",
        importer: manifest.lockfileImporter,
        dependencies: dependencies.map((d) => ({ name: d.name, declared: d.declared })),
      });
      pins = new Map([...pins, ...lock.versions]);
      formatVersion = lock.formatVersion;
    }
    result.push({
      manifest,
      formatVersion,
      rows: dependencies.map((d) => ({
        name: d.name,
        kind: d.group ? `${d.kind}/${d.group}` : d.kind,
        declared: d.declared,
        current: pins.get(d.name) ?? null,
        supported: d.supported,
      })),
    });
  }
  return { result, warnings };
}

describe("detectManifests (paths only)", () => {
  it("skips vendored / fixture directories and lists files to read", () => {
    const detection = detectManifests(
      treeOf({
        "package.json": "",
        "node_modules/a/package.json": "",
        "packages/x/dist/package.json": "",
        "test/fixtures/package.json": "",
        "examples/demo/pyproject.toml": "",
        ".venv/lib/requirements.txt": "",
        "apps/web/package.json": "",
        "pnpm-workspace.yaml": "",
        "requirements/dev.txt": "",
        "requirements-dev.txt": "",
        "constraints.txt": "",
        "docs/requirements.in": "",
        "docs/requirements.txt": "",
        "notes.txt": "",
      }),
    );
    expect(detection.candidates.map((c) => c.path)).toEqual([
      "apps/web/package.json",
      "constraints.txt",
      "docs/requirements.txt",
      "package.json",
      "requirements-dev.txt",
      "requirements/dev.txt",
    ]);
    expect(detection.filesToRead).toContain("pnpm-workspace.yaml");
    expect(detection.filesToRead).toContain("docs/requirements.in");
    expect(detection.candidates[0]!.blobSha).toBe("sha-apps/web/package.json");
  });

  it("caps at the shallowest manifests with a warning", () => {
    const files: Record<string, string> = { "package.json": "" };
    for (let i = 0; i < 30; i++) files[`packages/p${String(i).padStart(2, "0")}/package.json`] = "";
    const detection = detectManifests(treeOf(files), { maxManifests: 25 });
    expect(detection.candidates).toHaveLength(25);
    expect(detection.candidates.map((c) => c.path)).toContain("package.json");
    expect(detection.warnings[0]).toMatch(/only the 25 shallowest/);
  });

  it("uses manifestPaths as is (no skips, no cap) and warns about unknown ones", () => {
    const detection = detectManifests(treeOf({ "examples/a/package.json": "", "x/deps.txt": "" }), {
      manifestPaths: ["examples/a/package.json", "x/deps.txt", "missing/package.json", "README.md"],
    });
    expect(detection.candidates.map((c) => [c.path, c.format])).toEqual([
      ["examples/a/package.json", "package.json"],
      ["x/deps.txt", "requirements"],
    ]);
    expect(detection.warnings).toHaveLength(2);
  });

  it("resolves from a record of files too", () => {
    const tree = treeOf({ "package.json": "", "yarn.lock": "" });
    const { manifests } = resolveManifestGroups(detectManifests(tree), { "package.json": "{}" });
    expect(manifests[0]).toMatchObject({ packageManager: "YARN", lockfilePath: "yarn.lock" });
  });
});

describe("fixture repositories (§4 Part A)", () => {
  it("npm + package-lock.json workspace", async () => {
    const { result } = await scan({
      "package.json": JSON.stringify({
        name: "root",
        workspaces: ["apps/*"],
        dependencies: { react: "^18.2.0" },
        devDependencies: { typescript: "^5.4.0" },
      }),
      "apps/web/package.json": JSON.stringify({
        name: "web",
        dependencies: { react: "^17.0.0", lodash: "^4.17.0", "root-lib": "workspace:*" },
      }),
      "package-lock.json": PACKAGE_LOCK_V3,
    });
    const [web, root] = result;
    expect(root!.manifest).toMatchObject({
      path: "package.json",
      packageManager: "NPM",
      lockfilePath: "package-lock.json",
      workspaceRoot: null,
      workspaceMembers: ["apps/web/package.json"],
      checkOnlyReason: null,
    });
    expect(root!.formatVersion).toBe("3");
    expect(root!.rows).toEqual([
      { name: "react", kind: "PROD", declared: "^18.2.0", current: "18.2.0", supported: true },
      { name: "typescript", kind: "DEV", declared: "^5.4.0", current: "5.4.5", supported: true },
    ]);
    expect(web!.manifest).toMatchObject({
      packageManager: "NPM",
      lockfilePath: "package-lock.json",
      lockfileImporter: "apps/web",
      workspaceRoot: "package.json",
    });
    expect(web!.rows).toEqual([
      { name: "react", kind: "PROD", declared: "^17.0.0", current: "17.0.2", supported: true },
      { name: "lodash", kind: "PROD", declared: "^4.17.0", current: "4.17.21", supported: true },
      { name: "root-lib", kind: "PROD", declared: "workspace:*", current: null, supported: false },
    ]);
  });

  it("pnpm workspace", async () => {
    const { result } = await scan({
      "package.json": JSON.stringify({ name: "root", packageManager: "pnpm@9.12.0", devDependencies: { typescript: "^5.4.0" } }),
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - '!packages/ignored'\n",
      "apps/web/package.json": JSON.stringify({
        dependencies: { react: "^18.2.0", "react-dom": "^18.2.0", "@repo/ui": "workspace:*", zod: "catalog:" },
      }),
      "packages/ignored/package.json": JSON.stringify({ dependencies: { left: "^1.0.0" } }),
      "pnpm-lock.yaml": PNPM_LOCK_V9,
    });
    const byPath = new Map(result.map((r) => [r.manifest.path, r]));
    const web = byPath.get("apps/web/package.json")!;
    expect(web.manifest).toMatchObject({
      packageManager: "PNPM",
      lockfilePath: "pnpm-lock.yaml",
      lockfileImporter: "apps/web",
      workspaceRoot: "package.json",
      workspaceConfigPath: "pnpm-workspace.yaml",
    });
    expect(web.formatVersion).toBe("9.0");
    expect(web.rows).toEqual([
      { name: "react", kind: "PROD", declared: "^18.2.0", current: "18.2.0", supported: true },
      { name: "react-dom", kind: "PROD", declared: "^18.2.0", current: "18.2.0", supported: true },
      { name: "@repo/ui", kind: "PROD", declared: "workspace:*", current: null, supported: false },
      { name: "zod", kind: "PROD", declared: "catalog:", current: null, supported: false },
    ]);
    expect(byPath.get("package.json")!.rows[0]!.current).toBe("5.4.5");
    expect(byPath.get("package.json")!.manifest.workspaceMembers).toEqual(["apps/web/package.json"]);
    // Negated glob: not a member, its own (lockfile-less) project.
    expect(byPath.get("packages/ignored/package.json")!.manifest).toMatchObject({
      packageManager: "NONE",
      lockfilePath: null,
      workspaceRoot: null,
    });
  });

  it("Bun with the text bun.lock", async () => {
    const { result } = await scan({
      "package.json": JSON.stringify({ name: "root", workspaces: ["apps/*"], devDependencies: { typescript: "^5.4.0" } }),
      "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { react: "^18.2.0", ui: "workspace:*" } }),
      "bun.lock": BUN_LOCK,
    });
    const [web, root] = result;
    expect(root!.manifest).toMatchObject({ packageManager: "BUN", lockfilePath: "bun.lock", checkOnlyReason: null });
    expect(root!.formatVersion).toBe("1");
    expect(root!.rows[0]).toMatchObject({ name: "typescript", current: "5.4.5" });
    expect(web!.rows[0]).toMatchObject({ name: "react", current: "18.2.0" });
  });

  it("Bun with the binary bun.lockb: check only, declared ranges", async () => {
    const { result } = await scan({ "package.json": JSON.stringify({ dependencies: { react: "^18.2.0" } }) }, ["bun.lockb"]);
    expect(result[0]!.manifest).toMatchObject({ packageManager: "BUN", lockfilePath: "bun.lockb", warnings: [BUN_LOCKB_WARNING] });
    expect(result[0]!.manifest.checkOnlyReason).toMatch(/bun.lockb/);
    expect(result[0]!.rows[0]).toMatchObject({ declared: "^18.2.0", current: null });
  });

  it("Yarn classic and Berry: check only", async () => {
    const pkg = JSON.stringify({ dependencies: { lodash: "^4.17.21" }, devDependencies: { "@babel/core": "^7.1.0" } });
    for (const [lock, format] of [
      [YARN_CLASSIC, "classic"],
      [YARN_BERRY, "berry/8"],
    ] as const) {
      const { result } = await scan({ "package.json": pkg, "yarn.lock": lock });
      expect(result[0]!.manifest).toMatchObject({ packageManager: "YARN", warnings: [YARN_WARNING] });
      expect(result[0]!.manifest.checkOnlyReason).toBeTruthy();
      expect(result[0]!.formatVersion).toBe(format);
      expect(result[0]!.rows.map((r) => [r.name, r.current])).toEqual([
        ["lodash", "4.17.21"],
        ["@babel/core", "7.24.0"],
      ]);
    }
  });

  it("packageManager field wins over lockfiles and warns when declared manager lockfile is missing", async () => {
    const { result } = await scan(
      { "package.json": JSON.stringify({ packageManager: "yarn@4.1.0", dependencies: {} }), "pnpm-lock.yaml": PNPM_LOCK_V9 },
      ["yarn.lock"],
    );
    expect(result[0]!.manifest).toMatchObject({ packageManager: "YARN", lockfilePath: "yarn.lock" });

    const mismatch = await scan({
      "package.json": JSON.stringify({ packageManager: "pnpm@9.0.0", dependencies: { react: "^18.2.0" } }),
      "package-lock.json": PACKAGE_LOCK_V3,
    });
    expect(mismatch.result[0]!.manifest).toMatchObject({
      packageManager: "PNPM",
      lockfilePath: null,
    });
    expect(mismatch.result[0]!.manifest.warnings[0]).toMatch(/packageManager is pnpm but only package-lock\.json exists/);
  });

  it("uv workspace respects exclude globs", async () => {
    const { result } = await scan({
      "pyproject.toml":
        '[project]\nname = "root"\ndependencies = []\n[tool.uv.workspace]\nmembers = ["packages/*"]\nexclude = ["packages/excluded"]\n',
      "packages/included/pyproject.toml": '[project]\nname = "included"\ndependencies = ["httpx>=0.27"]\n',
      "packages/excluded/pyproject.toml": '[project]\nname = "excluded"\ndependencies = ["httpx>=0.27"]\n',
      "uv.lock": UV_LOCK,
    });
    const byPath = new Map(result.map((r) => [r.manifest.path, r.manifest]));
    expect(byPath.get("pyproject.toml")!.workspaceMembers).toEqual(["packages/included/pyproject.toml"]);
    expect(byPath.get("packages/included/pyproject.toml")!.workspaceRoot).toBe("pyproject.toml");
    expect(byPath.get("packages/excluded/pyproject.toml")!.workspaceRoot).toBeNull();
    expect(byPath.get("packages/excluded/pyproject.toml")!.lockfilePath).toBeNull();
  });

  it("uv project", async () => {
    const { result } = await scan({
      "pyproject.toml": '[project]\nname = "demo"\nrequires-python = ">=3.11"\ndependencies = ["httpx>=0.27", "rich==13.7.1"]\n',
      "uv.lock": UV_LOCK,
    });
    expect(result[0]!.manifest).toMatchObject({ ecosystem: "PYPI", packageManager: "UV", lockfilePath: "uv.lock" });
    expect(result[0]!.formatVersion).toBe("1/2");
    expect(result[0]!.rows.map((r) => [r.name, r.declared, r.current])).toEqual([
      ["httpx", ">=0.27", "0.27.0"],
      ["rich", "==13.7.1", "13.7.1"],
    ]);
  });

  it("uv workspace member uses the root uv.lock", async () => {
    const { result } = await scan({
      "pyproject.toml": '[project]\nname = "root"\ndependencies = []\n[tool.uv.workspace]\nmembers = ["packages/*"]\n',
      "packages/lib/pyproject.toml": '[project]\nname = "lib"\ndependencies = ["httpx>=0.27"]\n',
      "uv.lock": UV_LOCK,
    });
    const lib = result.find((r) => r.manifest.path === "packages/lib/pyproject.toml")!;
    expect(lib.manifest).toMatchObject({
      packageManager: "UV",
      lockfilePath: "uv.lock",
      workspaceRoot: "pyproject.toml",
      lockfileImporter: "packages/lib",
    });
    expect(lib.rows[0]!.current).toBe("0.27.0");
  });

  it("Poetry project", async () => {
    const { result } = await scan({
      "pyproject.toml":
        '[tool.poetry]\nname = "demo"\n\n[tool.poetry.dependencies]\npython = "^3.11"\nDjango = "^5.0"\nmylib = { git = "https://github.com/a/b.git" }\n',
      "poetry.lock": POETRY_LOCK,
    });
    expect(result[0]!.manifest).toMatchObject({ packageManager: "POETRY", lockfilePath: "poetry.lock" });
    expect(result[0]!.formatVersion).toBe("2.0");
    expect(result[0]!.rows).toEqual([
      { name: "django", kind: "PROD", declared: "^5.0", current: "5.0.3", supported: true },
      { name: "mylib", kind: "PROD", declared: "", current: null, supported: false },
    ]);
  });

  it("pyproject without lockfile → NONE; [tool.uv] alone → UV", async () => {
    const plain = await scan({ "pyproject.toml": '[project]\nname = "x"\ndependencies = ["a>=1"]\n' });
    expect(plain.result[0]!.manifest).toMatchObject({ packageManager: "NONE", lockfilePath: null });
    const uv = await scan({ "pyproject.toml": '[project]\nname = "x"\n[tool.uv]\ndev-dependencies = []\n' });
    expect(uv.result[0]!.manifest).toMatchObject({ packageManager: "UV", lockfilePath: null });
  });

  it("hashed requirements.txt", async () => {
    const hash = "a".repeat(64);
    const { result } = await scan({
      "requirements.txt": `django==4.2.7 \\\n    --hash=sha256:${hash}\nrequests==2.31.0 \\\n    --hash=sha256:${hash}\n`,
    });
    expect(result[0]!.manifest).toMatchObject({ packageManager: "PIP", lockfilePath: null, checkOnlyReason: null });
    expect(result[0]!.rows.map((r) => [r.name, r.declared, r.current])).toEqual([
      ["django", "==4.2.7", "4.2.7"],
      ["requests", "==2.31.0", "2.31.0"],
    ]);
  });

  it("pip-tools: the .in is the declared spec, the compiled .txt the current version", async () => {
    const { result } = await scan({
      "requirements.in": "django>=4.2\nrequests\n",
      "requirements.txt":
        "#\n# This file is autogenerated by pip-compile with Python 3.12\n# by the following command:\n#\n#    pip-compile\n#\ndjango==4.2.7\n    # via -r requirements.in\nrequests==2.31.0\n",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.manifest).toMatchObject({
      path: "requirements.in",
      packageManager: "PIP_TOOLS",
      lockfilePath: "requirements.txt",
      blobSha: "sha-requirements.in",
      lockfileBlobSha: "sha-requirements.txt",
    });
    expect(result[0]!.manifest.checkOnlyReason).toMatch(/pip-compile/);
    expect(result[0]!.rows.map((r) => [r.name, r.declared, r.current])).toEqual([
      ["django", ">=4.2", "4.2.7"],
      ["requests", "", "2.31.0"],
    ]);
  });
});
