import { MAX_MANIFEST_BYTES } from "@repopulse/deps";
import { describe, expect, it, vi } from "vitest";

import {
  BLOB_CACHE_TTL_SECONDS,
  createRedisBlobCache,
  createRedisLockfileCache,
  createRedisRegistryCache,
  createRedisTreeCache,
  lockfileCacheKey,
  MAX_TREE_CACHE_BYTES,
  TREE_CACHE_TTL_SECONDS,
} from "./registry-cache.js";

function fakeRedis() {
  const store = new Map<string, string>();
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const set = vi.fn(async (key: string, value: string, _mode: string, _ttl: number) => {
    store.set(key, value);
    return "OK" as const;
  });
  return { store, get, set };
}

describe("createRedisRegistryCache", () => {
  it("stores and reads entries with PX retentionMs and handles corrupt/missing entries gracefully", async () => {
    const redis = fakeRedis();
    const cache = createRedisRegistryCache(redis as never);

    expect(await cache.get("deps:reg:npm:react")).toBeNull();
    await cache.set("deps:reg:npm:react", { body: '{"ok":true}', storedAt: 1000, etag: '"e1"' }, 1234.6);
    expect(redis.set).toHaveBeenCalledWith(
      "deps:reg:npm:react",
      '{"body":"{\\"ok\\":true}","storedAt":1000,"etag":"\\"e1\\""}',
      "PX",
      1235,
    );
    expect(await cache.get("deps:reg:npm:react")).toEqual({ body: '{"ok":true}', storedAt: 1000, etag: '"e1"' });

    redis.store.set("bad-json", "{broken");
    expect(await cache.get("bad-json")).toBeNull();
    redis.store.set("bad-shape", JSON.stringify({ body: 123 }));
    expect(await cache.get("bad-shape")).toBeNull();

    redis.get.mockRejectedValueOnce(new Error("redis down"));
    expect(await cache.get("deps:reg:npm:react")).toBeNull();
    redis.set.mockRejectedValueOnce(new Error("redis down"));
    await expect(cache.set("deps:reg:npm:react", { body: "{}", storedAt: 1 }, 0)).resolves.toBeUndefined();
  });
});

describe("createRedisBlobCache", () => {
  it("caches blobs up to MAX_MANIFEST_BYTES and ignores oversized blobs or Redis errors", async () => {
    const redis = fakeRedis();
    const cache = createRedisBlobCache(redis as never);

    await cache.set("sha1", "hello");
    expect(redis.set).toHaveBeenCalledWith("deps:blob:sha1", "hello", "EX", BLOB_CACHE_TTL_SECONDS);
    expect(await cache.get("sha1")).toBe("hello");

    await cache.set("oversize", "x".repeat(MAX_MANIFEST_BYTES + 1));
    expect(redis.store.has("deps:blob:oversize")).toBe(false);

    redis.get.mockRejectedValueOnce(new Error("boom"));
    expect(await cache.get("sha1")).toBeNull();
    redis.set.mockRejectedValueOnce(new Error("boom"));
    await expect(cache.set("sha2", "ok")).resolves.toBeUndefined();
  });
});

describe("createRedisLockfileCache & lockfileCacheKey", () => {
  it("produces deterministic keys per sha, importer, and dependency list", () => {
    const k1 = lockfileCacheKey("sha-a", "", [{ name: "react", declared: "^18.0.0" }]);
    const k2 = lockfileCacheKey("sha-a", "apps/web", [{ name: "react", declared: "^18.0.0" }]);
    const k3 = lockfileCacheKey("sha-a", "", [{ name: "react", declared: "^19.0.0" }]);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toMatch(/^sha-a-[0-9a-f]{40}$/);
  });

  it("round-trips Map versions and handles errors as cache misses", async () => {
    const redis = fakeRedis();
    const cache = createRedisLockfileCache(redis as never);
    const val = { versions: new Map([["react", "18.2.0"]]), formatVersion: "3", warnings: ["w1"] };

    await cache.set("k1", val);
    expect(redis.set).toHaveBeenCalledWith("deps:lockread:k1", expect.any(String), "EX", BLOB_CACHE_TTL_SECONDS);
    const loaded = await cache.get("k1");
    expect(loaded).toEqual(val);

    redis.store.set("deps:lockread:corrupt", "{bad");
    expect(await cache.get("corrupt")).toBeNull();
    redis.get.mockRejectedValueOnce(new Error("err"));
    expect(await cache.get("k1")).toBeNull();
  });
});

describe("createRedisBlobCache batching & createRedisTreeCache", () => {
  it("supports mget/pipeline batching on BlobCache", async () => {
    const store = new Map<string, string>();
    const mget = vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null));
    const piped: Array<[string, string, string, number]> = [];
    const pipeline = vi.fn(() => ({
      set(k: string, v: string, m: string, ttl: number) {
        piped.push([k, v, m, ttl]);
        store.set(k, v);
      },
      exec: vi.fn(async () => []),
    }));
    const redis = {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v);
        return "OK" as const;
      }),
      mget,
      pipeline,
    };
    const cache = createRedisBlobCache(redis as never);
    await cache.setMany?.([
      { sha: "s1", text: "a" },
      { sha: "s2", text: "b" },
      { sha: "big", text: "x".repeat(MAX_MANIFEST_BYTES + 1) },
    ]);
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(piped).toHaveLength(2);

    const hits = await cache.getMany?.(["s1", "s2", "s1", "missing"]);
    expect(mget).toHaveBeenCalledWith("deps:blob:s1", "deps:blob:s2", "deps:blob:missing");
    expect(hits).toEqual(
      new Map([
        ["s1", "a"],
        ["s2", "b"],
      ]),
    );
  });

  it("caches Git tree snapshots up to MAX_TREE_CACHE_BYTES", async () => {
    const redis = fakeRedis();
    const treeCache = createRedisTreeCache(redis as never);

    await treeCache.set(42n, "c1", {
      entries: [{ path: "package.json", type: "blob", sha: "s1", size: 10 }],
      truncated: false,
    });
    expect(redis.set).toHaveBeenCalledWith("deps:tree:42:c1", expect.any(String), "EX", TREE_CACHE_TTL_SECONDS);
    expect(await treeCache.get(42n, "c1")).toEqual({
      entries: [{ path: "package.json", type: "blob", sha: "s1", size: 10 }],
      truncated: false,
    });

    const huge = Array.from({ length: 40_000 }, (_, i) => ({
      path: `packages/pkg-${i}/src/very-long-file-name-${i}.ts`,
      type: "blob" as const,
      sha: "a".repeat(40),
      size: 100,
    }));
    expect(Buffer.byteLength(JSON.stringify({ entries: huge, truncated: false }), "utf8")).toBeGreaterThan(
      MAX_TREE_CACHE_BYTES,
    );
    await treeCache.set(42n, "huge", { entries: huge, truncated: false });
    expect(await treeCache.get(42n, "huge")).toBeNull();
  });
});
