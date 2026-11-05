import { describe, expect, it, vi } from "vitest";
import {
  cachedGet,
  createLimiter,
  createMemoryRegistryCache,
  mapWithConcurrency,
  RegistryUnavailableError,
  registryCacheKey,
} from "./cache.js";
import { toGitHubRepoUrl } from "./github-url.js";
import { fetchNpmPackage, npmPackageUrl } from "./npm.js";
import { fetchPypiPackage, versionFromFilename } from "./pypi.js";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url, init ?? {});
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, ...init });

const ABBREVIATED = {
  name: "@scope/pkg",
  modified: "2026-10-01T00:00:00.000Z",
  "dist-tags": { latest: "1.2.0" },
  versions: {
    "1.0.0": { name: "@scope/pkg", version: "1.0.0" },
    "1.1.0": { name: "@scope/pkg", version: "1.1.0", deprecated: "use 1.2" },
    "1.2.0": { name: "@scope/pkg", version: "1.2.0" },
    "2.0.0-beta.1": { name: "@scope/pkg", version: "2.0.0-beta.1" },
  },
};
const FULL = {
  name: "@scope/pkg",
  repository: { type: "git", url: "git+https://github.com/scope/pkg.git" },
  time: {
    created: "2025-01-01T00:00:00.000Z",
    modified: "2026-10-01T00:00:00.000Z",
    "1.0.0": "2025-01-01T00:00:00.000Z",
    "1.1.0": "2025-06-01T00:00:00.000Z",
    "1.2.0": "2026-09-30T00:00:00.000Z",
    "2.0.0-beta.1": "2026-10-01T00:00:00.000Z",
  },
};

describe("npm registry", () => {
  it("encodes scoped names", () => {
    expect(npmPackageUrl("@scope/pkg")).toBe("https://registry.npmjs.org/@scope%2Fpkg");
    expect(npmPackageUrl("react")).toBe("https://registry.npmjs.org/react");
  });

  it("fetches the abbreviated packument and the times, then serves from cache", async () => {
    const { fetch, calls } = fakeFetch((_url, init) => {
      const accept = (init.headers as Record<string, string>).Accept;
      return accept === "application/vnd.npm.install-v1+json"
        ? json(ABBREVIATED, { headers: { etag: '"abbr-1"' } })
        : json(FULL, { headers: { etag: '"full-1"' } });
    });
    const cache = createMemoryRegistryCache();
    let now = 1_000_000;
    const options = { fetch, cache, now: () => now };
    const result = await fetchNpmPackage("@scope/pkg", options);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.package.versions.map((v) => [v.version, v.deprecated])).toEqual([
      ["1.0.0", false],
      ["1.1.0", true],
      ["1.2.0", false],
      ["2.0.0-beta.1", false],
    ]);
    expect(result.package.versions[2]!.publishedAt?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
    expect(result.package.latestTag).toBe("1.2.0");
    expect(result.package.sourceRepoUrl).toBe("https://github.com/scope/pkg");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://registry.npmjs.org/@scope%2Fpkg");

    // Fresh cache: no requests.
    await fetchNpmPackage("@scope/pkg", options);
    expect(calls).toHaveLength(2);

    // Stale: revalidated with If-None-Match; 304 keeps the body; times unchanged (same `modified`).
    now += 2 * 60 * 60 * 1000;
    const revalidating = fakeFetch(() => new Response(null, { status: 304 }));
    const again = await fetchNpmPackage("@scope/pkg", { ...options, fetch: revalidating.fetch });
    expect(again.found).toBe(true);
    expect(revalidating.calls).toHaveLength(1);
    expect(revalidating.calls[0]!.headers["If-None-Match"]).toBe('"abbr-1"');
    expect(await cache.get(registryCacheKey("npm", "@scope/pkg"))).not.toBeNull();
  });

  it("refetches times when the abbreviated document is newer", async () => {
    const cache = createMemoryRegistryCache();
    const first = fakeFetch((_url, init) =>
      (init.headers as Record<string, string>).Accept === "application/json" ? json(FULL) : json(ABBREVIATED),
    );
    await fetchNpmPackage("@scope/pkg", { fetch: first.fetch, cache, ttlMs: 0 });
    const newer = { ...ABBREVIATED, modified: "2026-11-01T00:00:00.000Z", versions: { ...ABBREVIATED.versions, "1.3.0": {} } };
    const newerFull = { ...FULL, time: { ...FULL.time, modified: "2026-11-01T00:00:00.000Z", "1.3.0": "2026-11-01T00:00:00.000Z" } };
    const second = fakeFetch((_url, init) =>
      (init.headers as Record<string, string>).Accept === "application/json" ? json(newerFull) : json(newer),
    );
    const result = await fetchNpmPackage("@scope/pkg", { fetch: second.fetch, cache, ttlMs: 0 });
    expect(second.calls).toHaveLength(2);
    expect(result.found && result.package.versions.find((v) => v.version === "1.3.0")?.publishedAt?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("maps 404 to not found and 429 / 5xx / network errors to RegistryUnavailableError", async () => {
    const notFound = await fetchNpmPackage("missing", { fetch: fakeFetch(() => new Response("", { status: 404 })).fetch });
    expect(notFound).toEqual({ found: false, reason: "Not on the public npm registry" });
    await expect(
      fetchNpmPackage("busy", { fetch: fakeFetch(() => new Response("", { status: 429, headers: { "retry-after": "30" } })).fetch }),
    ).rejects.toMatchObject({ name: "RegistryUnavailableError", status: 429, retryAfterMs: 30_000 });
    await expect(fetchNpmPackage("down", { fetch: fakeFetch(() => new Response("", { status: 503 })).fetch })).rejects.toBeInstanceOf(
      RegistryUnavailableError,
    );
    await expect(
      fetchNpmPackage("net", {
        fetch: fakeFetch(() => {
          throw new TypeError("fetch failed");
        }).fetch,
      }),
    ).rejects.toBeInstanceOf(RegistryUnavailableError);
    expect(await fetchNpmPackage("../etc/passwd", { fetch: fakeFetch(() => json({})).fetch })).toMatchObject({ found: false });
  });
});

const SIMPLE = {
  meta: { "api-version": "1.1" },
  name: "django",
  versions: ["4.2.7", "5.0.0", "5.0.1rc1", "5.1.0"],
  files: [
    { filename: "Django-4.2.7-py3-none-any.whl", hashes: { sha256: "A".repeat(64) }, "requires-python": ">=3.8", yanked: false, "upload-time": "2023-11-01T10:00:00.000000Z" },
    { filename: "Django-4.2.7.tar.gz", hashes: { sha256: "b".repeat(64) }, "requires-python": ">=3.8", yanked: false, "upload-time": "2023-11-01T09:00:00.000000Z" },
    { filename: "Django-5.0.0-py3-none-any.whl", hashes: { sha256: "c".repeat(64) }, "requires-python": ">=3.10", yanked: "broken", "upload-time": "2023-12-04T00:00:00Z" },
    { filename: "django-5.0.1rc1-py3-none-any.whl", hashes: { sha256: "d".repeat(64) }, "requires-python": ">=3.10", yanked: false, "upload-time": "2024-01-01T00:00:00Z" },
    { filename: "django-5.1.0-py3-none-any.whl", hashes: { sha256: "e".repeat(64) }, "requires-python": null, yanked: false, "upload-time": "2024-08-07T00:00:00Z" },
  ],
};

describe("PyPI registry", () => {
  it("parses versions from file names including alternative archive extensions", () => {
    expect(versionFromFilename("Django-4.2.7-py3-none-any.whl", "django")).toBe("4.2.7");
    expect(versionFromFilename("Django-4.2.7-bad.whl", "django")).toBeNull();
    expect(versionFromFilename("zope.interface-6.0.tar.gz", "zope-interface")).toBe("6.0");
    expect(versionFromFilename("my-old-pkg-1.0.zip", "my-old-pkg")).toBe("1.0");
    expect(versionFromFilename("pkg-1.0-py2.7.egg", "pkg")).toBe("1.0");
    expect(versionFromFilename("pkg-1.2.tar.bz2", "pkg")).toBe("1.2");
    expect(versionFromFilename("pkg-1.3.tar.xz", "pkg")).toBe("1.3");
    expect(versionFromFilename("pkg-1.4.tgz", "pkg")).toBe("1.4");
    expect(versionFromFilename("pkg-1.5.tar", "pkg")).toBe("1.5");
    expect(versionFromFilename("pkg-1.6.exe", "pkg")).toBe("1.6");
    expect(versionFromFilename("pkg-1.7.msi", "pkg")).toBe("1.7");
    expect(versionFromFilename("README", "pkg")).toBeNull();
  });

  it("handles partial yank filtering (keeps live files when at least one file is not yanked)", async () => {
    const partialSimple = {
      meta: { "api-version": "1.1" },
      name: "pkg",
      versions: ["1.0.0"],
      files: [
        {
          filename: "pkg-1.0.0-py3-none-any.whl",
          hashes: { sha256: "a".repeat(64) },
          "requires-python": ">=3.7",
          yanked: "bad wheel",
          "upload-time": "2024-01-01T00:00:00Z",
        },
        {
          filename: "pkg-1.0.0.tar.gz",
          hashes: { sha256: "b".repeat(64) },
          "requires-python": ">=3.9",
          yanked: false,
          "upload-time": "2024-01-02T00:00:00Z",
        },
      ],
    };
    const res = await fetchPypiPackage("pkg", {
      fetch: fakeFetch((url) => (url.endsWith("/json") ? new Response("", { status: 404 }) : json(partialSimple))).fetch,
    });
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.package.versions[0]).toMatchObject({
      version: "1.0.0",
      yanked: false,
      requiresPython: [">=3.9"],
      sha256: ["b".repeat(64)],
    });
  });

  it("reads PEP 691 JSON with PEP 700 times, yanked, requires-python and hashes", async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith("/json")
        ? json({ info: { project_urls: { Documentation: "https://docs.djangoproject.com", Source: "https://github.com/django/django" } } })
        : json(SIMPLE),
    );
    const result = await fetchPypiPackage("Django", { fetch });
    expect(calls.map((c) => c.url)).toEqual(["https://pypi.org/simple/django/", "https://pypi.org/pypi/django/json"]);
    expect(calls[0]!.headers.Accept).toBe("application/vnd.pypi.simple.v1+json");
    expect(result.found).toBe(true);
    if (!result.found) return;
    const [v427, v500, v501rc1, v510] = result.package.versions;
    expect(v427).toMatchObject({ version: "4.2.7", yanked: false, requiresPython: [">=3.8"] });
    expect(v427!.sha256).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(v427!.publishedAt?.toISOString()).toBe("2023-11-01T09:00:00.000Z");
    expect(v500).toMatchObject({ version: "5.0.0", yanked: true });
    expect(v501rc1!.version).toBe("5.0.1rc1");
    expect(v510).toMatchObject({ requiresPython: null });
    expect(result.package.sourceRepoUrl).toBe("https://github.com/django/django");
  });

  it("ignores project_urls failures and maps 404", async () => {
    const result = await fetchPypiPackage("django", {
      fetch: fakeFetch((url) => (url.endsWith("/json") ? new Response("", { status: 502 }) : json(SIMPLE))).fetch,
    });
    expect(result.found && result.package.sourceRepoUrl).toBeNull();
    expect(await fetchPypiPackage("nope", { fetch: fakeFetch(() => new Response("", { status: 404 })).fetch })).toEqual({
      found: false,
      reason: "Not on the public PyPI",
    });
  });
});

describe("helpers", () => {
  it("normalizes GitHub URLs and rejects . / .. repo segments", () => {
    expect(toGitHubRepoUrl("git+https://github.com/facebook/react.git")).toBe("https://github.com/facebook/react");
    expect(toGitHubRepoUrl("git@github.com:a/b.git")).toBe("https://github.com/a/b");
    expect(toGitHubRepoUrl("ssh://git@github.com/a/b.git")).toBe("https://github.com/a/b");
    expect(toGitHubRepoUrl("git://github.com/a/b")).toBe("https://github.com/a/b");
    expect(toGitHubRepoUrl("github:a/b")).toBe("https://github.com/a/b");
    expect(toGitHubRepoUrl("a/b")).toBe("https://github.com/a/b");
    expect(toGitHubRepoUrl("https://github.com/a/b/tree/main/packages/x")).toBe("https://github.com/a/b");
    expect(toGitHubRepoUrl("https://github.com/a/.")).toBeNull();
    expect(toGitHubRepoUrl("https://github.com/a/..")).toBeNull();
    expect(toGitHubRepoUrl("https://github.com/../b")).toBeNull();
    expect(toGitHubRepoUrl("https://gitlab.com/a/b")).toBeNull();
    expect(toGitHubRepoUrl(undefined)).toBeNull();
  });

  it("handles HTTP-date Retry-After, caller AbortSignal rethrow, corrupt derive wrapping, and memory cache TTL eviction", async () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    const retryDate = new Date(now + 45_000).toUTCString();
    await expect(
      cachedGet({
        registry: "npm",
        key: "k1",
        url: "https://registry.npmjs.org/pkg",
        accept: "application/json",
        options: {
          now: () => now,
          fetch: fakeFetch(() => new Response("", { status: 503, headers: { "retry-after": retryDate } })).fetch,
        },
      }),
    ).rejects.toMatchObject({
      name: "RegistryUnavailableError",
      status: 503,
      retryAfterMs: 45_000,
    });

    const controller = new AbortController();
    const abortErr = new DOMException("Caller aborted", "AbortError");
    controller.abort(abortErr);
    await expect(
      cachedGet({
        registry: "npm",
        key: "k2",
        url: "https://registry.npmjs.org/pkg",
        accept: "application/json",
        options: {
          signal: controller.signal,
          fetch: fakeFetch(() => {
            throw abortErr;
          }).fetch,
        },
      }),
    ).rejects.toBe(abortErr);

    await expect(
      cachedGet({
        registry: "npm",
        key: "k3",
        url: "https://registry.npmjs.org/pkg",
        accept: "application/json",
        options: {
          fetch: fakeFetch(() => new Response("not-json", { status: 200 })).fetch,
        },
        derive: (body) => JSON.stringify(JSON.parse(body)),
      }),
    ).rejects.toBeInstanceOf(RegistryUnavailableError);

    let clock = 1_000;
    const mem = createMemoryRegistryCache(() => clock);
    await mem.set("item", { body: "v", storedAt: clock }, 500);
    expect(mem.size()).toBe(1);
    expect(await mem.get("item")).not.toBeNull();
    clock = 1_501;
    expect(await mem.get("item")).toBeNull();
    expect(mem.size()).toBe(0);
  });

  it("limits concurrency", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      async (i) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return i * 2;
      },
      3,
    );
    expect(peak).toBe(3);
    expect(results[19]).toBe(38);
    expect(() => createLimiter(0)).toThrow(RangeError);
  });
});
