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
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url, init ?? {});
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (body: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status: 200, ...init, headers });
};

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
    const newer = {
      ...ABBREVIATED,
      modified: "2026-11-01T00:00:00.000Z",
      versions: { ...ABBREVIATED.versions, "1.3.0": {} },
    };
    const newerFull = {
      ...FULL,
      time: { ...FULL.time, modified: "2026-11-01T00:00:00.000Z", "1.3.0": "2026-11-01T00:00:00.000Z" },
    };
    const second = fakeFetch((_url, init) =>
      (init.headers as Record<string, string>).Accept === "application/json" ? json(newerFull) : json(newer),
    );
    const result = await fetchNpmPackage("@scope/pkg", { fetch: second.fetch, cache, ttlMs: 0 });
    expect(second.calls).toHaveLength(2);
    expect(result.found && result.package.versions.find((v) => v.version === "1.3.0")?.publishedAt?.toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });

  it("maps 404 to not found and 429 / 5xx / network errors to RegistryUnavailableError", async () => {
    const notFound = await fetchNpmPackage("missing", {
      fetch: fakeFetch(() => new Response("", { status: 404 })).fetch,
    });
    expect(notFound).toEqual({ found: false, reason: "Not on the public npm registry" });
    await expect(
      fetchNpmPackage("busy", {
        fetch: fakeFetch(() => new Response("", { status: 429, headers: { "retry-after": "30" } })).fetch,
      }),
    ).rejects.toMatchObject({ name: "RegistryUnavailableError", status: 429, retryAfterMs: 30_000 });
    await expect(
      fetchNpmPackage("down", { fetch: fakeFetch(() => new Response("", { status: 503 })).fetch }),
    ).rejects.toBeInstanceOf(RegistryUnavailableError);
    await expect(
      fetchNpmPackage("net", {
        fetch: fakeFetch(() => {
          throw new TypeError("fetch failed");
        }).fetch,
      }),
    ).rejects.toBeInstanceOf(RegistryUnavailableError);
    expect(await fetchNpmPackage("../etc/passwd", { fetch: fakeFetch(() => json({})).fetch })).toMatchObject({
      found: false,
    });
  });

  it("treats invalid or NaN modified timestamps as stale so invalid dates never compare as fresh", async () => {
    const cache = createMemoryRegistryCache();
    await cache.set(
      registryCacheKey("npm-time", "pkg"),
      {
        body: JSON.stringify({
          time: { modified: "not-a-date", "1.0.0": "2026-01-01T00:00:00.000Z" },
          repository: null,
        }),
        storedAt: 1_000,
      },
      60_000,
    );
    await cache.set(
      registryCacheKey("npm", "pkg"),
      {
        body: JSON.stringify({ modified: "2026-10-01T00:00:00.000Z", latest: "1.0.0", versions: { "1.0.0": false } }),
        storedAt: 1_000,
      },
      60_000,
    );

    const { fetch, calls } = fakeFetch(() =>
      json({
        name: "pkg",
        repository: null,
        time: { modified: "2026-10-01T00:00:00.000Z", "1.0.0": "2026-05-01T00:00:00.000Z" },
      }),
    );
    const result = await fetchNpmPackage("pkg", { fetch, cache, now: () => 1_000 });
    expect(calls).toHaveLength(1);
    expect(result.found && result.package.versions[0]?.publishedAt?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});

const SIMPLE = {
  meta: { "api-version": "1.1" },
  name: "django",
  versions: ["4.2.7", "5.0.0", "5.0.1rc1", "5.1.0"],
  files: [
    {
      filename: "Django-4.2.7-py3-none-any.whl",
      hashes: { sha256: "A".repeat(64) },
      "requires-python": ">=3.8",
      yanked: false,
      "upload-time": "2023-11-01T10:00:00.000000Z",
    },
    {
      filename: "Django-4.2.7.tar.gz",
      hashes: { sha256: "b".repeat(64) },
      "requires-python": ">=3.8",
      yanked: false,
      "upload-time": "2023-11-01T09:00:00.000000Z",
    },
    {
      filename: "Django-5.0.0-py3-none-any.whl",
      hashes: { sha256: "c".repeat(64) },
      "requires-python": ">=3.10",
      yanked: "broken",
      "upload-time": "2023-12-04T00:00:00Z",
    },
    {
      filename: "django-5.0.1rc1-py3-none-any.whl",
      hashes: { sha256: "d".repeat(64) },
      "requires-python": ">=3.10",
      yanked: false,
      "upload-time": "2024-01-01T00:00:00Z",
    },
    {
      filename: "django-5.1.0-py3-none-any.whl",
      hashes: { sha256: "e".repeat(64) },
      "requires-python": null,
      yanked: false,
      "upload-time": "2024-08-07T00:00:00Z",
    },
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
      fetch: fakeFetch((url) => (url.endsWith("/json") ? new Response("", { status: 404 }) : json(partialSimple)))
        .fetch,
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
        ? json({
            info: {
              project_urls: {
                Documentation: "https://docs.djangoproject.com",
                Source: "https://github.com/django/django",
              },
            },
          })
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
    expect(await fetchPypiPackage("nope", { fetch: fakeFetch(() => new Response("", { status: 404 })).fetch })).toEqual(
      {
        found: false,
        reason: "Not on the public PyPI",
      },
    );
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

  it("enforces timeoutMs, cancels bodies on 304/404/429/5xx, caps response bytes, deduplicates in-flight fetches, and evicts LRU entries", async () => {
    // 1. Timeout aborts slow fetch and maps to RegistryUnavailableError.
    const slowFetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new DOMException("Timed out", "TimeoutError")),
          );
        }),
    );
    await expect(
      cachedGet({
        registry: "npm",
        key: "t1",
        url: "https://registry.npmjs.org/slow",
        accept: "application/json",
        options: { fetch: slowFetch, timeoutMs: 15 },
      }),
    ).rejects.toBeInstanceOf(RegistryUnavailableError);

    // 2. Cancels response bodies on 304, 404, 429, 503.
    const cache = createMemoryRegistryCache(() => 1_000);
    await cache.set("reval", { body: "old", etag: '"e1"', storedAt: 0 }, 60_000);
    for (const status of [304, 404, 429, 503]) {
      const cancel = vi.fn(async () => {});
      const resp = {
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers(),
        body: { cancel },
      } as unknown as Response;
      const call = cachedGet({
        registry: "npm",
        key: status === 304 ? "reval" : `s-${status}`,
        url: "https://registry.npmjs.org/pkg",
        accept: "application/json",
        options: { cache, now: () => 1_000, ttlMs: 100, fetch: vi.fn(async () => resp) },
      });
      if (status === 429 || status === 503) {
        await expect(call).rejects.toBeInstanceOf(RegistryUnavailableError);
      } else {
        await expect(call).resolves.toBeDefined();
      }
      expect(cancel).toHaveBeenCalledTimes(1);
    }

    // 3. Enforces maxBytes via content-length and streaming chunks.
    const declaredBigCancel = vi.fn(async () => {});
    const declaredBigResp = {
      status: 200,
      ok: true,
      headers: new Headers({ "content-length": "99999" }),
      body: { cancel: declaredBigCancel },
    } as unknown as Response;
    await expect(
      cachedGet({
        registry: "npm",
        key: "big-hdr",
        url: "https://registry.npmjs.org/big",
        accept: "application/json",
        options: { maxBytes: 100, fetch: vi.fn(async () => declaredBigResp) },
      }),
    ).rejects.toBeInstanceOf(RegistryUnavailableError);
    expect(declaredBigCancel).toHaveBeenCalledTimes(1);

    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(60));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    await expect(
      cachedGet({
        registry: "npm",
        key: "big-stream",
        url: "https://registry.npmjs.org/big-stream",
        accept: "application/json",
        options: { maxBytes: 100, fetch: vi.fn(async () => new Response(stream, { status: 200 })) },
      }),
    ).rejects.toBeInstanceOf(RegistryUnavailableError);
    expect(streamCancelled).toBe(true);

    // 4. Single-flight deduplication across concurrent calls.
    let fetchCount = 0;
    const sharedCache = createMemoryRegistryCache();
    const sharedFetch = vi.fn(async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 10));
      return json({ ok: true });
    }) as unknown as typeof fetch;
    const [r1, r2, r3] = await Promise.all([
      cachedGet({
        registry: "npm",
        key: "sf",
        url: "https://registry.npmjs.org/sf",
        accept: "application/json",
        options: { cache: sharedCache, fetch: sharedFetch },
      }),
      cachedGet({
        registry: "npm",
        key: "sf",
        url: "https://registry.npmjs.org/sf",
        accept: "application/json",
        options: { cache: sharedCache, fetch: sharedFetch },
      }),
      cachedGet({
        registry: "npm",
        key: "sf",
        url: "https://registry.npmjs.org/sf",
        accept: "application/json",
        options: { cache: sharedCache, fetch: sharedFetch },
      }),
    ]);
    expect(fetchCount).toBe(1);
    expect([r1, r2, r3].every((r) => r.found && r.body === '{"ok":true}')).toBe(true);

    // 5. Bounded LRU eviction in createMemoryRegistryCache.
    const lru = createMemoryRegistryCache(() => 1_000, 2);
    await lru.set("a", { body: "1", storedAt: 1_000 }, 10_000);
    await lru.set("b", { body: "2", storedAt: 1_000 }, 10_000);
    // Touch "a" so "b" becomes least recently used.
    expect((await lru.get("a"))?.body).toBe("1");
    await lru.set("c", { body: "3", storedAt: 1_000 }, 10_000);
    expect(lru.size()).toBe(2);
    expect(await lru.get("b")).toBeNull();
    expect((await lru.get("a"))?.body).toBe("1");
    expect((await lru.get("c"))?.body).toBe("3");
  });
});
