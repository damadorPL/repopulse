import { describe, expect, it, vi } from "vitest";
import { MAX_MANIFEST_BYTES } from "@repopulse/deps";
import { analyzeProject, capDependencies, createSnapshotReader, lookupRegistries, parseIgnoreRules, planAnalysis } from "./analysis";
import { createFakeGitHub } from "./testing/fake-github";
import { createFakePrisma, seed } from "./testing/fake-prisma";
import { fakeAccess, fakeQueues, fakeRegistry, job, NOW, version } from "./testing/fixtures";
import { processDepsUpdate } from "./processors/deps-update.processor";
import { processDepsScan } from "./processors/deps-scan.processor";

async function analyze(files: Record<string, string>, manifestPaths: string[] = []) {
  const entries = Object.entries(files).map(([path, text]) => ({ path, type: "blob" as const, sha: path, size: Buffer.byteLength(text) }));
  const readBlobs = vi.fn(async (refs: { path: string; sha: string }[]) => refs.map(({ path, sha }) => ({ path, sha, content: files[path]! })));
  const reader = createSnapshotReader(entries, readBlobs);
  return analyzeProject({ entries, manifestPaths, reader });
}

const npmManifest = (dependencies: Record<string, string>) => JSON.stringify({ dependencies });
const supported = (analysis: Awaited<ReturnType<typeof analyze>>) => Object.fromEntries(
  analysis.manifests.flatMap((manifest) => manifest.dependencies.map(({ dependency }) => [dependency.name, dependency.supported])),
);

describe("registry/source safety in shared dependency analysis", () => {
  it("blocks a private default registry before public lookups, even without a lockfile", async () => {
    const analysis = await analyze({
      "package.json": npmManifest({ internal: "1.0.0" }),
      ".npmrc": "registry=https://private.example/npm/\n",
    });
    expect(supported(analysis)).toEqual({ internal: false });
    expect(analysis.manifests[0]!.detected.lockfilePath).toBeNull();
    const registry = fakeRegistry({ "NPM:internal": [version("1.0.0"), version("1.1.0")] });
    const lookups = await lookupRegistries(analysis.manifests.flatMap((m) => m.dependencies.filter((d) => d.dependency.supported).map((d) => ({ ecosystem: d.ecosystem, name: d.dependency.name }))), registry);
    const planned = planAnalysis(analysis.manifests, lookups, { maxUpdateLevel: "MINOR", includePrereleases: false, minReleaseAgeDays: 3, rangeStrategy: "BUMP", ignoreRules: [] }, new Map(), NOW);
    expect(registry).not.toHaveBeenCalled();
    expect(planned[0]!.selection.status).toBe("UNSUPPORTED_SOURCE");
  });

  it("applies scoped registries without disabling unrelated public dependencies", async () => {
    expect(supported(await analyze({
      "package.json": npmManifest({ "@private/pkg": "1.0.0", "@public/pkg": "1.0.0", react: "1.0.0" }),
      ".npmrc": "registry=https://registry.npmjs.org/\n@private:registry=https://private.example/\n@public:registry=https://registry.npmjs.org/\n",
    }))).toEqual({ "@private/pkg": false, "@public/pkg": true, react: true });
  });

  it("inherits ancestor config and honors nearer default and scoped overrides", async () => {
    expect(supported(await analyze({
      ".npmrc": "registry=https://private.example/\n@private:registry=https://private.example/\n",
      "apps/client/.npmrc": "registry=https://registry.npmjs.org/\n@private:registry=https://registry.npmjs.org/\n",
      "apps/client/package.json": npmManifest({ "@private/pkg": "1.0.0", react: "1.0.0" }),
      "apps/server/package.json": npmManifest({ internal: "1.0.0" }),
    }))).toEqual({ "@private/pkg": true, react: true, internal: false });
  });

  it("lets an explicit public scope override a private default", async () => {
    expect(supported(await analyze({
      "package.json": npmManifest({ "@public/pkg": "1.0.0", internal: "1.0.0" }),
      ".npmrc": "registry=https://private.example/\n@public:registry=https://registry.npmjs.org/\n",
    }))).toEqual({ "@public/pkg": true, internal: false });
  });

  it("inherits a private default while allowing a nearer public scope in the same format", async () => {
    expect(supported(await analyze({
      ".npmrc": "registry=https://private.example/\n",
      "app/.npmrc": "@public:registry=https://registry.npmjs.org/\n",
      "app/package.json": npmManifest({ "@public/pkg": "1.0.0", internal: "1.0.0" }),
    }))).toEqual({ "@public/pkg": true, internal: false });
  });

  it.each([
    [".yarnrc.yml", "npmRegistryServer: https://private.example/\n"],
    ["bunfig.toml", '[install]\nregistry="https://private.example/"\n'],
  ])("does not let public .npmrc override a private %s registry", async (path, config) => {
    expect(supported(await analyze({
      "package.json": npmManifest({ internal: "1.0.0" }),
      [path]: config,
      ".npmrc": "registry=https://registry.npmjs.org/\n",
    }))).toEqual({ internal: false });
  });

  it.each([
    [".yarnrc.yml", "npmScopes:\n  private:\n    npmRegistryServer: https://private.example/\n"],
    ["bunfig.toml", '[install.scopes]\nprivate = "https://private.example/"\n'],
    ["pnpm-workspace.yaml", 'registries:\n  "@private": https://private.example/\n'],
  ])("checks scoped settings in %s", async (path, config) => {
    expect(supported(await analyze({ "package.json": npmManifest({ "@private/pkg": "1.0.0", react: "1.0.0" }), [path]: config })))
      .toEqual({ "@private/pkg": false, react: true });
  });

  it("fails closed for an existing oversized registry config", async () => {
    const analysis = await analyze({ "package.json": npmManifest({ internal: "1.0.0" }), ".npmrc": " ".repeat(1024 * 1024 + 1) });
    expect(supported(analysis)).toEqual({ internal: false });
  });

  it("rejects a registry path on the public host and unresolved variables", async () => {
    for (const registry of ["https://registry.npmjs.org/private/", "${PRIVATE_REGISTRY}"]) {
      expect(supported(await analyze({ "package.json": npmManifest({ internal: "1.0.0" }), ".npmrc": `registry=${registry}\n` })))
        .toEqual({ internal: false });
    }
  });

  it.each([
    ["pip.conf", "[global]\nextra-index-url=https://private.example/simple\n"],
    ["uv.toml", '[[index]]\nurl="https://private.example/simple"\n'],
    ["poetry.toml", '[repositories.private]\nurl="https://private.example/simple"\n'],
  ])("blocks Python packages affected by ancestor %s", async (path, config) => {
    expect(supported(await analyze({ [path]: config, "app/requirements.txt": "internal==1.0.0\n" }))).toEqual({ internal: false });
  });

  it("accepts the explicit public PyPI default index", async () => {
    expect(supported(await analyze({ "uv.toml": 'index-url="https://pypi.org/simple/"\n', "requirements.txt": "requests==1.0.0\n" })))
      .toEqual({ requests: true });
  });

  it("blocks only uv packages mapped to an explicit private index or repository source", async () => {
    const pyproject = `[project]\ndependencies=["internal==1.0.0", "requests==1.0.0", "from-git==1.0.0"]\n[[tool.uv.index]]\nname="private"\nurl="https://private.example/simple"\nexplicit=true\n[tool.uv.sources]\ninternal={index="private"}\nfrom-git={git="https://github.com/acme/internal"}\n`;
    expect(supported(await analyze({ "pyproject.toml": pyproject }))).toEqual({ internal: false, requests: true, "from-git": false });
  });

  it("blocks Python dependencies when a primary Poetry source is private", async () => {
    expect(supported(await analyze({ "pyproject.toml": '[tool.poetry.dependencies]\ninternal="1.0.0"\n[[tool.poetry.source]]\nname="private"\nurl="https://private.example/simple"\npriority="primary"\n' })))
      .toEqual({ internal: false });
  });

  it("applies custom extra indexes from included constraints to all requirements", async () => {
    expect(supported(await analyze({ "requirements.txt": "-c constraints.txt\ninternal==1.0.0\n", "constraints.txt": "--extra-index-url https://private.example/simple\n" })))
      .toEqual({ internal: false });
  });
});

describe("registry safety at processor boundaries", () => {
  it("stores unsupported rows without looking private package names up publicly", async () => {
    const prisma = createFakePrisma();
    seed(prisma);
    const github = createFakeGitHub({ files: { "package.json": npmManifest({ internal: "1.0.0" }), ".npmrc": "registry=https://private.example/\n" } });
    const registry = fakeRegistry({ "NPM:internal": [version("1.0.0"), version("1.1.0")] });
    await processDepsScan(job({ projectId: "p1", trigger: "schedule" }), {
      prisma: prisma as never, ...fakeQueues(), access: fakeAccess(github), github: github.api, registry,
      lockfileRegeneration: false, now: () => NOW,
    });
    expect(registry).not.toHaveBeenCalled();
    expect(prisma.dependencyUpdate.rows).toEqual([expect.objectContaining({ name: "internal", status: "UNSUPPORTED_SOURCE", targetVersion: null })]);
  });

  it("rechecks registry config before manifest-only PRs, including stale previously-outdated rows", async () => {
    const prisma = createFakePrisma();
    seed(prisma, { project: { updateMode: "MANUAL_PR", lastScannedAt: NOW } });
    prisma.dependencyPrOwner.rows.push({ githubRepoId: 42, projectId: "p1" });
    prisma.dependencyManifest.rows.push({ id: "m1", projectId: "p1", path: "package.json", packageManager: "NONE", ecosystem: "NPM", lockfilePath: null });
    prisma.dependencyUpdate.rows.push({ id: "d1", projectId: "p1", manifestId: "m1", name: "internal", kind: "PROD", group: "", declared: "1.0.0", currentVersion: "1.0.0", targetVersion: "1.1.0", status: "OUTDATED", level: "MINOR" });
    const github = createFakeGitHub({ files: { "package.json": npmManifest({ internal: "1.0.0" }), ".npmrc": "registry=https://private.example/\n" } });
    const queues = fakeQueues();
    const registry = fakeRegistry({ "NPM:internal": [version("1.0.0"), version("1.1.0")] });
    await processDepsUpdate(job({ projectId: "p1", groupKey: "all", trigger: "manual" }), {
      prisma: prisma as never, redis: queues.redis, updateQueue: queues.updateQueue, notifyQueue: queues.notifyQueue,
      access: fakeAccess(github, { installed: true }), github: github.api, registry, sandbox: null,
      appBaseUrl: "https://pulse.example.com", now: () => NOW,
    });
    expect(registry).not.toHaveBeenCalled();
    expect(github.state.calls.filter((call) => call.startsWith("commitFiles"))).toEqual([]);
    expect(github.prs).toEqual([]);
  });
});

describe("snapshot reader, lockCache, truncated trees, capDependencies, and parseIgnoreRules", () => {
  it("createSnapshotReader memoizes reads, uses blobCache, and skips oversized or non-blob entries", async () => {
    const entries = [
      { path: "package.json", type: "blob" as const, sha: "sha-pkg", size: 20 },
      { path: "huge.json", type: "blob" as const, sha: "sha-huge", size: MAX_MANIFEST_BYTES + 10 },
      { path: "dir", type: "tree" as const, sha: "sha-dir", size: null },
    ];
    const readBlobs = vi.fn(async (refs: Array<{ path: string; sha: string }>) =>
      refs.map((r) => ({ path: r.path, sha: r.sha, content: '{"name":"demo"}' })),
    );
    const cacheStore = new Map<string, string>();
    const blobCache = {
      get: vi.fn(async (sha: string) => cacheStore.get(sha) ?? null),
      set: vi.fn(async (sha: string, text: string) => {
        cacheStore.set(sha, text);
      }),
    };

    const reader = createSnapshotReader(entries, readBlobs, blobCache);
    expect(reader.sha("package.json")).toBe("sha-pkg");
    expect(reader.sha("dir")).toBeNull();
    expect(await reader.read("huge.json")).toBeNull();
    expect(await reader.read("missing.json")).toBeNull();
    expect(reader.downloaded).toBe(0);

    expect(await reader.read("package.json")).toBe('{"name":"demo"}');
    expect(await reader.read("package.json")).toBe('{"name":"demo"}');
    expect(reader.downloaded).toBe(1);
    expect(readBlobs).toHaveBeenCalledTimes(1);
    expect(blobCache.set).toHaveBeenCalledWith("sha-pkg", '{"name":"demo"}');

    // Second reader hits blobCache without calling readBlobs
    const reader2 = createSnapshotReader(entries, readBlobs, blobCache);
    expect(await reader2.read("package.json")).toBe('{"name":"demo"}');
    expect(reader2.downloaded).toBe(0);
  });

  it("analyzeProject records truncated tree warning, uses lockCache, and capDependencies & parseIgnoreRules handle bounds", async () => {
    const lockJson = JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { a: "^1.0.0", b: "^2.0.0" } }, "node_modules/a": { version: "1.2.0" }, "node_modules/b": { version: "2.1.0" } },
    });
    const files: Record<string, string> = {
      "package.json": npmManifest({ a: "^1.0.0", b: "^2.0.0" }),
      "package-lock.json": lockJson,
    };
    const entries = Object.entries(files).map(([path, text]) => ({ path, type: "blob" as const, sha: `sha-${path}`, size: text.length }));
    const readBlobs = vi.fn(async (refs: Array<{ path: string; sha: string }>) =>
      refs.map(({ path, sha }) => ({ path, sha, content: files[path]! })),
    );
    const lockStore = new Map<string, { versions: Map<string, string>; formatVersion: string | null; warnings: string[] }>();
    const lockCache = {
      get: vi.fn(async (k: string) => lockStore.get(k) ?? null),
      set: vi.fn(async (k: string, v: { versions: Map<string, string>; formatVersion: string | null; warnings: string[] }) => {
        lockStore.set(k, v);
      }),
    };

    const reader1 = createSnapshotReader(entries, readBlobs);
    const analysis1 = await analyzeProject({ entries, manifestPaths: [], reader: reader1, lockCache, truncated: true });
    expect(analysis1.warnings).toContain("The repository tree is too large: only part of it was searched for manifests");
    expect(lockCache.set).toHaveBeenCalledTimes(1);
    expect(analysis1.manifests[0]!.dependencies.map((d) => [d.dependency.name, d.currentVersion])).toEqual([
      ["a", "1.2.0"],
      ["b", "2.1.0"],
    ]);

    // Second run serves lockfile versions from lockCache without downloading package-lock.json
    const reader2 = createSnapshotReader(entries, readBlobs);
    await analyzeProject({ entries, manifestPaths: [], reader: reader2, lockCache });
    expect(reader2.downloaded).toBe(1); // Only package.json downloaded

    const capped = capDependencies(analysis1, 1);
    expect(capped.manifests[0]!.dependencies).toHaveLength(1);
    expect(capped.warnings.some((w) => w.includes("2 dependencies found; only the first 1 are checked"))).toBe(true);

    expect(parseIgnoreRules([{ name: "react", versions: ">=19" }])).toEqual([{ name: "react", versions: ">=19" }]);
    expect(parseIgnoreRules("corrupt")).toEqual([]);
  });

  it("analyzes multi-document pnpm-lock.yaml cleanly and does not cache lockfile reads with warnings", async () => {
    const multiDocPnpmLock = [
      "---",
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    configDependencies: {}",
      "    packageManagerDependencies:",
      "      pnpm:",
      "        specifier: 12.16.1",
      "        version: 12.16.1",
      "---",
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    devDependencies:",
      "      typescript:",
      "        specifier: 7.0.2",
      "        version: 7.0.2",
      "  apps/web:",
      "    dependencies:",
      "      react:",
      "        specifier: 19.0.0",
      "        version: 19.0.0",
      "",
    ].join("\n");

    const okFiles: Record<string, string> = {
      "package.json": JSON.stringify({ packageManager: "pnpm@12.16.1", devDependencies: { typescript: "7.0.2" } }),
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "apps/web/package.json": JSON.stringify({ dependencies: { react: "19.0.0" } }),
      "pnpm-lock.yaml": multiDocPnpmLock,
    };
    const okEntries = Object.entries(okFiles).map(([path, text]) => ({
      path,
      type: "blob" as const,
      sha: `sha-${path}`,
      size: text.length,
    }));
    const okReader = createSnapshotReader(okEntries, async (refs) =>
      refs.map(({ path, sha }) => ({ path, sha, content: okFiles[path]! })),
    );
    const lockStore = new Map<string, { versions: Map<string, string>; formatVersion: string | null; warnings: string[] }>();
    const lockCache = {
      get: vi.fn(async (k: string) => lockStore.get(k) ?? null),
      set: vi.fn(async (k: string, v: { versions: Map<string, string>; formatVersion: string | null; warnings: string[] }) => {
        lockStore.set(k, v);
      }),
    };

    const okAnalysis = await analyzeProject({ entries: okEntries, manifestPaths: [], reader: okReader, lockCache });
    expect(okAnalysis.manifests.map((m) => [m.detected.path, m.lockfileFormatVersion, m.warnings, m.dependencies.map((d) => [d.dependency.name, d.currentVersion])])).toEqual([
      ["apps/web/package.json", "9.0", [], [["react", "19.0.0"]]],
      ["package.json", "9.0", [], [["typescript", "7.0.2"]]],
    ]);
    expect(lockCache.set).toHaveBeenCalledTimes(2);

    // Unparsable lockfile emits warning and is NOT cached in lockCache
    lockCache.set.mockClear();
    const badFiles: Record<string, string> = {
      "package.json": npmManifest({ a: "^1.0.0" }),
      "package-lock.json": "{not json",
    };
    const badEntries = Object.entries(badFiles).map(([path, text]) => ({
      path,
      type: "blob" as const,
      sha: `bad-${path}`,
      size: text.length,
    }));
    const badReader = createSnapshotReader(badEntries, async (refs) =>
      refs.map(({ path, sha }) => ({ path, sha, content: badFiles[path]! })),
    );
    const badAnalysis = await analyzeProject({ entries: badEntries, manifestPaths: [], reader: badReader, lockCache });
    expect(badAnalysis.manifests[0]!.warnings[0]).toMatch(/could not be parsed/);
    expect(lockCache.set).not.toHaveBeenCalled();
  });
});
