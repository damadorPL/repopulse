import { describe, expect, it, vi } from "vitest";
import { analyzeProject, createSnapshotReader, lookupRegistries, planAnalysis } from "./analysis";
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
