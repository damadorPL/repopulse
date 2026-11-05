import { describe, expect, it, vi } from "vitest";
import { MAX_MANIFEST_BYTES } from "@repopulse/deps";
import {
  BLOB_CACHE_TTL_SECONDS,
  createRedisBlobCache,
  createRedisLockfileCache,
  createRedisRegistryCache,
  lockfileCacheKey,
} from "./registry-cache";

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
    expect(redis.set).toHaveBeenCalledWith("deps:reg:npm:react", '{"body":"{\\"ok\\":true}","storedAt":1000,"etag":"\\"e1\\""}', "PX", 1235);
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
