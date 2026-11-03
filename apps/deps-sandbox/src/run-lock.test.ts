import { EventEmitter } from "node:events";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { lockRequestSchema, type LockRequest } from "@repopulse/deps/sandbox-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolVersions } from "./commands.js";
import {
  buildSandboxEnv,
  defaultSpawn,
  findConfigRegistries,
  findPyprojectRegistries,
  prepareFiles,
  runLock,
  sanitizeOutput,
  TailBuffer,
  type RunLockOptions,
  type SpawnedProcess,
  type SpawnFn,
  type SpawnOptions,
} from "./run-lock.js";

const TOOLS: ToolVersions = { npm: "12.2.1", pnpm: "12.14.0", bun: "1.4.3", uv: "0.13.1", poetry: "2.5.1" };
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const file = (p: string, content: string) => ({ path: p, contentBase64: b64(content) });
const parse = (req: LockRequest) => lockRequestSchema.parse(req);

const NPM_LOCK = JSON.stringify({ name: "x", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {} });
const PKG = JSON.stringify({ name: "x", version: "1.0.0" });

// ---------------------------------------------------------------------------------------------------------------
// Fake processes
// ---------------------------------------------------------------------------------------------------------------

interface FakeCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

type FakeBehavior = (call: FakeCall, child: FakeChild) => void | Promise<void>;

class FakeChild extends EventEmitter implements SpawnedProcess {
  readonly pid = 424242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, signal));
  }
}

function fakeSpawn(behavior: FakeBehavior): { spawn: SpawnFn; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const child = new FakeChild();
    setImmediate(() => {
      Promise.resolve(behavior(call, child)).catch((err: unknown) => {
        child.stderr.write(String(err));
        child.exit(1);
      });
    });
    return child;
  };
  return { spawn, calls };
}

/** A behavior that writes `content` to `<cwd>/<name>` and exits 0. */
const writes =
  (name: string, content: string): FakeBehavior =>
  async (call, child) => {
    await fs.writeFile(path.join(call.options.cwd, name), content);
    child.stdout.write("added 0 packages\n");
    child.exit(0);
  };

let tmpRoot: string;
const killTree = vi.fn((child: SpawnedProcess) => void child.kill("SIGKILL"));

function options(extra: Partial<RunLockOptions> = {}): RunLockOptions {
  return { tmpRoot, proxy: "http://deps-egress:3128", tools: TOOLS, timeoutMs: 10_000, killTree, ...extra };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deps-sandbox-test-"));
  killTree.mockClear();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function expectNoJobDirs(): Promise<void> {
  expect(await fs.readdir(tmpRoot)).toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

describe("prepareFiles", () => {
  it("strips risky config anywhere in the tree and installed / VCS directories", () => {
    const prepared = prepareFiles([
      file("package.json", PKG),
      file(".npmrc", "save-exact=true\n"),
      file("packages/a/.npmrc", "engine-strict=true\n"),
      file(".pnpmfile.cjs", "module.exports = {}"),
      file("apps/b/.pnpmfile.mjs", "export default {}"),
      file(".yarnrc.yml", "nodeLinker: node-modules\n"),
      file("bunfig.toml", "[install]\nexact = true\n"),
      file("py/pip.conf", "[global]\ntimeout = 60\n"),
      file("py/poetry.toml", "[virtualenvs]\nin-project = true\n"),
      file("py/uv.toml", "native-tls = true\n"),
      file(".env", "BUN_CONFIG_REGISTRY=http://evil\n"),
      file("node_modules/x/package.json", PKG),
      file(".git/config", "[core]\n"),
      file(".poetry/plugins/x.py", "import os\n"),
    ]);
    expect(prepared.files.map((f) => f.path)).toEqual(["package.json"]);
    expect(prepared.stripped).toHaveLength(13);
    expect(prepared.registries).toEqual([]);
  });

  it("reports custom registries in stripped config and keeps default ones", () => {
    const prepared = prepareFiles([
      file(".npmrc", "registry=https://registry.npmjs.org/\n"),
      file("a/.npmrc", "@acme:registry=https://npm.acme.dev/\n//npm.acme.dev/:_authToken=${NPM_TOKEN}\n"),
      file("bunfig.toml", '[install]\nregistry = "https://bun.acme.dev"\n'),
      file("pip.conf", "[global]\nindex-url = https://pypi.acme.dev/simple\n"),
      file(".yarnrc.yml", 'npmRegistryServer: "https://registry.yarnpkg.com"\n'),
    ]);
    expect(prepared.registries).toEqual(["a/.npmrc: registry", "bunfig.toml: install.registry", "pip.conf: index-url"]);
  });

  it("reports custom indexes in pyproject.toml and pnpm-workspace.yaml", () => {
    const prepared = prepareFiles([
      file("pyproject.toml", '[project]\nname = "x"\n\n[[tool.uv.index]]\nname = "acme"\nurl = "https://acme"\n'),
      file("pnpm-workspace.yaml", "packages:\n  - apps/*\nregistry: https://npm.acme.dev/\n"),
    ]);
    expect(prepared.registries).toEqual(["pyproject.toml: [tool.uv.index]", "pnpm-workspace.yaml: registry"]);
  });

  it("rejects invalid base64 and duplicate paths", () => {
    expect(() => prepareFiles([{ path: "a", contentBase64: "!!!" }])).toThrow(/base64/);
    expect(() => prepareFiles([file("a", "1"), file("a", "2")])).toThrow(/duplicate/);
  });
});

describe("findPyprojectRegistries", () => {
  it("finds uv and Poetry indexes in all their forms", () => {
    expect(findPyprojectRegistries('[tool.uv.index]\nurl = "x"\n')).toEqual(["[tool.uv.index]"]);
    expect(findPyprojectRegistries('[[tool.poetry.source]]\nname = "x"\n')).toEqual(["[[tool.poetry.source]]"]);
    expect(findPyprojectRegistries('[ tool . "uv" ]\nindex-url = "https://pypi.acme.dev/simple"\n')).toEqual([
      "tool.uv.index-url",
    ]);
    expect(findPyprojectRegistries('[tool]\nuv = { index = [{ url = "https://x" }] }\n')).toEqual([
      "tool.uv (inline table)",
    ]);
    expect(findPyprojectRegistries('[tool.uv.pip]\nextra-index-url = ["https://x/simple"]\n')).toEqual([
      "tool.uv.pip.extra-index-url",
    ]);
  });

  it("ignores defaults, comments and multi-line strings", () => {
    const text = [
      "[project]",
      'name = "x" # [tool.uv.index]',
      'description = """',
      "[[tool.poetry.source]]",
      '"""',
      "[tool.uv]",
      'index-url = "https://pypi.org/simple"',
      "# [[tool.uv.index]]",
      "dev-dependencies = []",
      "[tool.uv.sources]",
      'foo = { workspace = true }',
    ].join("\n");
    expect(findPyprojectRegistries(text)).toEqual([]);
  });
});

describe("findConfigRegistries", () => {
  it("handles .yarnrc, uv.toml and poetry.toml", () => {
    expect(findConfigRegistries(".yarnrc", 'registry "https://npm.acme.dev"\n')).toEqual(["registry"]);
    expect(findConfigRegistries("uv.toml", '[[index]]\nurl = "https://x"\n')).toEqual(["[[index]]"]);
    expect(findConfigRegistries("poetry.toml", "[repositories.acme]\nurl = 'x'\n")).toEqual(["repositories"]);
    expect(findConfigRegistries(".npmrc", "; registry=https://evil\n")).toEqual([]);
  });
});

describe("sanitizeOutput", () => {
  it("strips ANSI and control characters and redacts credentials", () => {
    const raw = [
      "\u001b[31mERR!\u001b[0m 404 Not Found - GET https://user:hunter2@npm.acme.dev/x",
      "//npm.acme.dev/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789",
      "Authorization: Bearer abc.def.ghi-123456",
      "token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "GITHUB_TOKEN=s3cr3tvalue",
      "hash deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "bell\u0007 and \r\n crlf",
    ].join("\n");
    const out = sanitizeOutput(raw, "/tmp/lock-abc");
    expect(out).not.toMatch(/\u001b|\u0007/);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("abc.def.ghi");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("s3cr3tvalue");
    expect(out).not.toContain("deadbeef");
    expect(out).toContain("https://***@npm.acme.dev/x");
    expect(out).toContain("ERR! 404 Not Found");
  });

  it("replaces the job dir and keeps only the tail", () => {
    expect(sanitizeOutput("error in /tmp/lock-abc/repo/package.json", "/tmp/lock-abc")).toBe(
      "error in <job>/repo/package.json",
    );
    const long = Array.from({ length: 500 }, (_, i) => `line ${i} ünïcode`).join("\n");
    const out = sanitizeOutput(long, undefined, 2048);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(2048);
    expect(out.endsWith("line 499 ünïcode")).toBe(true);
    expect(out).not.toContain("�");
  });
});

describe("TailBuffer", () => {
  it("keeps the newest bytes up to the limit", () => {
    const buf = new TailBuffer(10);
    buf.push("0123456");
    buf.push("789abc");
    expect(buf.toString()).toBe("3456789abc");
    buf.push("x".repeat(25));
    expect(buf.toString()).toBe("x".repeat(10));
    expect(buf.byteLength).toBe(10);
  });
});

describe("buildSandboxEnv", () => {
  it("builds the env from scratch: no inherited secrets, caches inside the job dir", () => {
    process.env.GITHUB_TOKEN = "should-not-leak";
    process.env.DEPS_SANDBOX_TOKEN = "should-not-leak";
    try {
      const env = buildSandboxEnv("/tmp/lock-1", { proxy: "http://deps-egress:3128", path: "/usr/bin" });
      expect(Object.values(env)).not.toContain("should-not-leak");
      expect(Object.keys(env).filter((k) => /TOKEN/i.test(k))).toEqual([]);
      expect(env).toMatchObject({
        HOME: path.join("/tmp/lock-1", "home"),
        PATH: "/usr/bin",
        HTTP_PROXY: "http://deps-egress:3128",
        HTTPS_PROXY: "http://deps-egress:3128",
        CI: "1",
        npm_config_ignore_scripts: "true",
        UV_NO_BUILD: "1",
      });
      for (const [key, value] of Object.entries(env)) {
        if (/_DIR$|^npm_config_cache$|^TMPDIR$|^XDG_/.test(key)) expect(value.startsWith(path.join("/tmp/lock-1"))).toBe(true);
      }
      expect(buildSandboxEnv("/tmp/lock-1", { proxy: null }).HTTPS_PROXY).toBeUndefined();
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.DEPS_SANDBOX_TOKEN;
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// runLock with fake processes
// ---------------------------------------------------------------------------------------------------------------

describe("runLock", () => {
  it("runs the command in the workdir with the minimal env and returns the lockfile", async () => {
    const { spawn, calls } = fakeSpawn(writes("package-lock.json", NPM_LOCK));
    const result = await runLock(
      parse({
        packageManager: "NPM",
        workdir: "",
        files: [file("package.json", PKG), file("package-lock.json", NPM_LOCK), file(".npmrc", "save-exact=true")],
        upgrade: [],
        expectLockfile: "package-lock.json",
      }),
      options({ spawn }),
    );
    expect(result).toEqual({ ok: true, lockfile: { path: "package-lock.json", contentBase64: b64(NPM_LOCK) } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("npm");
    expect(calls[0]!.args).toContain("--ignore-scripts");
    expect(calls[0]!.options.env.HTTPS_PROXY).toBe("http://deps-egress:3128");
    expect(calls[0]!.options.env.HOME.startsWith(tmpRoot)).toBe(true);
    expect(killTree).toHaveBeenCalled(); // stragglers in the process group are reaped
    await expectNoJobDirs();
  });

  it("runs in a sub-directory workdir and strips risky files before the command sees the tree", async () => {
    let seen: string[] = [];
    const { spawn, calls } = fakeSpawn(async (call, child) => {
      const root = path.resolve(call.options.cwd, "..", "..");
      seen = [
        existsSync(path.join(root, "apps", "web", "package.json")) ? "package.json" : "",
        existsSync(path.join(root, "apps", "web", ".npmrc")) ? ".npmrc" : "",
        existsSync(path.join(root, ".pnpmfile.cjs")) ? ".pnpmfile.cjs" : "",
      ].filter(Boolean);
      await writes("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")(call, child);
    });
    const result = await runLock(
      parse({
        packageManager: "PNPM",
        workdir: "apps/web",
        files: [
          file("apps/web/package.json", PKG),
          file("apps/web/.npmrc", "ignore-scripts=false"),
          file(".pnpmfile.cjs", "require('child_process').execSync('touch /tmp/pwned')"),
        ],
        upgrade: [],
        expectLockfile: "apps/web/pnpm-lock.yaml",
      }),
      options({ spawn }),
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["package.json"]);
    expect(calls[0]!.options.cwd.endsWith(path.join("repo", "apps", "web"))).toBe(true);
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining(["--ignore-scripts", "--ignore-pnpmfile", "--lockfile-only"]),
    );
  });

  it("returns COMMAND_FAILED with a sanitized tail", async () => {
    const { spawn } = fakeSpawn((_call, child) => {
      child.stderr.write("\u001b[31mERR_PNPM_FETCH_404\u001b[0m GET https://u:p4ss@npm.acme.dev/x\n");
      child.exit(1);
    });
    const result = await runLock(
      parse({
        packageManager: "PNPM",
        workdir: "",
        files: [file("package.json", PKG)],
        upgrade: [],
        expectLockfile: "pnpm-lock.yaml",
      }),
      options({ spawn }),
    );
    expect(result).toEqual({
      ok: false,
      code: "COMMAND_FAILED",
      stderrTail: "ERR_PNPM_FETCH_404 GET https://***@npm.acme.dev/x",
    });
    await expectNoJobDirs();
  });

  it("returns LOCKFILE_MISSING when the tool wrote nothing, and refuses a symlinked lockfile", async () => {
    const req = parse({
      packageManager: "NPM",
      workdir: "",
      files: [file("package.json", PKG)],
      upgrade: [],
      expectLockfile: "package-lock.json",
    });
    const quiet = fakeSpawn((_call, child) => child.exit(0));
    expect(await runLock(req, options({ spawn: quiet.spawn }))).toMatchObject({ ok: false, code: "LOCKFILE_MISSING" });

    const outside = path.join(tmpRoot, "..", `outside-${Date.now()}.json`);
    await fs.writeFile(outside, NPM_LOCK);
    try {
      const symlinker = fakeSpawn(async (call, child) => {
        try {
          await fs.symlink(outside, path.join(call.options.cwd, "package-lock.json"));
        } catch {
          // symlinks may need privileges on Windows: the plain "missing" case above already covers that path
        }
        child.exit(0);
      });
      expect(await runLock(req, options({ spawn: symlinker.spawn }))).toMatchObject({
        ok: false,
        code: "LOCKFILE_MISSING",
      });
    } finally {
      await fs.rm(outside, { force: true });
    }
    await expectNoJobDirs();
  });

  it("kills the process tree on timeout", async () => {
    const { spawn } = fakeSpawn(() => undefined); // never exits on its own
    killTree.mockImplementation((child: SpawnedProcess) => {
      (child as FakeChild).exit(null, "SIGKILL");
    });
    const result = await runLock(
      parse({
        packageManager: "UV",
        workdir: "",
        files: [file("pyproject.toml", '[project]\nname = "x"\nversion = "1"\n')],
        upgrade: [{ name: "requests", version: "2.33.0" }],
        expectLockfile: "uv.lock",
      }),
      options({ spawn, timeoutMs: 50 }),
    );
    expect(result).toMatchObject({ ok: false, code: "TIMEOUT" });
    expect(killTree).toHaveBeenCalled();
    killTree.mockImplementation((child: SpawnedProcess) => void child.kill("SIGKILL"));
    await expectNoJobDirs();
  });

  it("answers BUSY when aborted by a shutdown", async () => {
    const { spawn } = fakeSpawn(() => undefined);
    killTree.mockImplementation((child: SpawnedProcess) => (child as FakeChild).exit(null, "SIGKILL"));
    const abort = new AbortController();
    const pending = runLock(
      parse({
        packageManager: "NPM",
        workdir: "",
        files: [file("package.json", PKG)],
        upgrade: [],
        expectLockfile: "package-lock.json",
      }),
      options({ spawn, signal: abort.signal, onPrepared: () => void setTimeout(() => abort.abort(), 10) }),
    );
    expect(await pending).toMatchObject({ ok: false, code: "BUSY" });
    killTree.mockImplementation((child: SpawnedProcess) => void child.kill("SIGKILL"));
    await expectNoJobDirs();
  });

  it("refuses custom registries before running anything", async () => {
    const { spawn, calls } = fakeSpawn((_c, child) => child.exit(0));
    const result = await runLock(
      parse({
        packageManager: "POETRY",
        workdir: "",
        files: [
          file(
            "pyproject.toml",
            '[tool.poetry]\nname = "x"\n\n[[tool.poetry.source]]\nname = "acme"\nurl = "https://pypi.acme.dev/simple"\n',
          ),
        ],
        upgrade: [],
        expectLockfile: "poetry.lock",
      }),
      options({ spawn }),
    );
    expect(result).toEqual({
      ok: false,
      code: "UNSUPPORTED_REGISTRY",
      stderrTail: "custom package registry configured: pyproject.toml: [[tool.poetry.source]]",
    });
    expect(calls).toHaveLength(0);
    await expectNoJobDirs();
  });

  it("refuses an unsupported tool version or lockfile format, before and after the run", async () => {
    const { spawn, calls } = fakeSpawn(writes("pnpm-lock.yaml", "lockfileVersion: '10.0'\n"));
    const base = {
      packageManager: "PNPM" as const,
      workdir: "",
      upgrade: [],
      expectLockfile: "pnpm-lock.yaml",
    };
    expect(
      await runLock(
        parse({ ...base, files: [file("package.json", JSON.stringify({ packageManager: "pnpm@9.15.0" }))] }),
        options({ spawn }),
      ),
    ).toMatchObject({ ok: false, code: "UNSUPPORTED_TOOL_VERSION" });
    expect(
      await runLock(
        parse({ ...base, files: [file("package.json", PKG), file("pnpm-lock.yaml", "lockfileVersion: '6.0'\n")] }),
        options({ spawn }),
      ),
    ).toMatchObject({ ok: false, code: "UNSUPPORTED_TOOL_VERSION" });
    expect(calls).toHaveLength(0);

    // The tool rewrote the lockfile in another format: refused.
    expect(
      await runLock(
        parse({ ...base, files: [file("package.json", PKG), file("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")] }),
        options({ spawn }),
      ),
    ).toEqual({ ok: false, code: "UNSUPPORTED_TOOL_VERSION", stderrTail: "lockfile format changed (9.0 → 10.0)" });
    expect(
      await runLock(
        parse({ ...base, packageManager: "BUN", expectLockfile: "bun.lockb", files: [file("package.json", PKG)] }),
        options({ spawn }),
      ),
    ).toMatchObject({ ok: false, code: "UNSUPPORTED_TOOL_VERSION" });
    await expectNoJobDirs();
  });

  it("rejects bad requests: wrong lockfile name, missing manifest, conflicting paths, flag-like names", async () => {
    const { spawn, calls } = fakeSpawn((_c, child) => child.exit(0));
    const run = (req: LockRequest) => runLock(parse(req), options({ spawn }));
    const base = { packageManager: "NPM" as const, workdir: "", upgrade: [], expectLockfile: "package-lock.json" };

    expect(await run({ ...base, files: [file("package.json", PKG)], expectLockfile: "yarn.lock" })).toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(await run({ ...base, files: [file("README.md", "x")] })).toMatchObject({ code: "BAD_REQUEST" });
    expect(await run({ ...base, files: [file("package.json", PKG), file("a", "1"), file("a/b", "2")] })).toMatchObject(
      { code: "BAD_REQUEST" },
    );
    expect(
      await run({
        ...base,
        files: [file("package.json", PKG)],
        upgrade: [{ name: "--registry=http://evil", version: "1.0.0" }],
        lockfileOnly: true,
      }),
    ).toMatchObject({ code: "BAD_REQUEST" });
    expect(calls).toHaveLength(0);
    await expectNoJobDirs();
  });

  it("Bun lockfileOnly: restores the manifests between update and install", async () => {
    const manifestsSeen: string[] = [];
    const { spawn, calls } = fakeSpawn(async (call, child) => {
      const manifest = path.join(call.options.cwd, "package.json");
      manifestsSeen.push(await fs.readFile(manifest, "utf8"));
      // `bun update` rewrites the range; the runner must undo it before `bun install`.
      await fs.writeFile(manifest, JSON.stringify({ dependencies: { ms: "^2.1.3" } }));
      await writes("bun.lock", '{\n  "lockfileVersion": 1,\n}\n')(call, child);
    });
    const original = JSON.stringify({ dependencies: { ms: "^2.0.0" } });
    const result = await runLock(
      parse({
        packageManager: "BUN",
        workdir: "",
        files: [file("package.json", original), file("bun.lock", '{\n  "lockfileVersion": 1,\n}\n')],
        upgrade: [{ name: "ms", version: "2.1.3" }],
        lockfileOnly: true,
        expectLockfile: "bun.lock",
      }),
      options({ spawn }),
    );
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.args[0])).toEqual(["update", "install"]);
    expect(manifestsSeen).toEqual([original, original]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Real npm: lifecycle scripts and pnpmfiles never run
// ---------------------------------------------------------------------------------------------------------------

function findNpmCli(): string | null {
  const dir = path.dirname(process.execPath);
  for (const candidate of [
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const npmCli = findNpmCli();

describe.skipIf(!npmCli)("runLock with the real npm", () => {
  it("writes package-lock.json without running preinstall / postinstall scripts or a pnpmfile", async () => {
    const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), "deps-sandbox-marker-"));
    const marker = (name: string) => path.join(markerDir, name).replace(/\\/g, "/");
    const touch = (name: string) => `node -e "require('fs').writeFileSync('${marker(name)}','x')"`;
    const pkg = JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      private: true,
      scripts: { preinstall: touch("preinstall"), install: touch("install"), postinstall: touch("postinstall") },
    });
    const pnpmfile = `require('fs').writeFileSync('${marker("pnpmfile")}', 'x'); module.exports = {};`;
    let treeFiles: string[] = [];

    // Run npm through the current node binary (no shell, no PATH lookup of npm.cmd on Windows).
    const spawn: SpawnFn = (command, args, opts) =>
      defaultSpawn(process.execPath, [npmCli!, ...args], { ...opts, detached: false });
    try {
      const result = await runLock(
        parse({
          packageManager: "NPM",
          workdir: "",
          files: [
            file("package.json", pkg),
            file(".npmrc", "ignore-scripts=false\n"),
            file(".pnpmfile.cjs", pnpmfile),
          ],
          upgrade: [],
          expectLockfile: "package-lock.json",
        }),
        {
          tmpRoot,
          proxy: null,
          tools: TOOLS,
          timeoutMs: 120_000,
          spawn,
          onPrepared: async ({ treeRoot }) => {
            treeFiles = await fs.readdir(treeRoot);
          },
        },
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) {
        const lock = JSON.parse(Buffer.from(result.lockfile.contentBase64, "base64").toString("utf8"));
        expect(lock.name).toBe("fixture");
        expect([2, 3]).toContain(lock.lockfileVersion);
      }
      expect(treeFiles.sort()).toEqual(["package.json"]);
      expect(await fs.readdir(markerDir)).toEqual([]);
      await expectNoJobDirs();
    } finally {
      await fs.rm(markerDir, { recursive: true, force: true });
    }
  }, 120_000);
});
