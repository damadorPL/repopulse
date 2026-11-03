import { createHash } from "node:crypto";
import { MAX_MANIFEST_BYTES, type LockfileVersions, type RegistryCache, type RegistryCacheEntry } from "@repopulse/deps";
import type { Redis } from "@repopulse/queue";
import { createLogger } from "./logger";

const log = createLogger("deps-cache");

type CacheRedis = Pick<Redis, "get" | "set">;

/**
 * Redis-backed {@link RegistryCache} (`deps:reg:<eco>:<name>`, body + ETag). Freshness is decided by
 * `@repopulse/deps` from `storedAt`; Redis only expires entries after `retentionMs`, so stale ones are revalidated
 * with `If-None-Match`. Cache failures are logged and treated as misses: the registry is the source of truth.
 */
export function createRedisRegistryCache(redis: CacheRedis): RegistryCache {
  return {
    async get(key) {
      try {
        const raw = await redis.get(key);
        if (!raw) return null;
        const entry = JSON.parse(raw) as Partial<RegistryCacheEntry>;
        if (typeof entry.body !== "string" || typeof entry.storedAt !== "number") return null;
        return { body: entry.body, storedAt: entry.storedAt, ...(typeof entry.etag === "string" ? { etag: entry.etag } : {}) };
      } catch (error) {
        log.warn(`registry cache read failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
    async set(key, entry, retentionMs) {
      try {
        await redis.set(key, JSON.stringify(entry), "PX", Math.max(1, Math.round(retentionMs)));
      } catch (error) {
        log.warn(`registry cache write failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/**
 * Content-addressed text cache for small repository blobs (manifests, workspace files: ≤ `MAX_MANIFEST_BYTES`),
 * keyed by Git blob SHA (`deps:blob:<sha>`). A blob SHA never changes meaning, so an unchanged file is never
 * downloaded twice within the retention.
 */
export interface BlobCache {
  get(sha: string): Promise<string | null>;
  set(sha: string, text: string): Promise<void>;
}

/**
 * Lockfile read results (`readLockfile` output) keyed by lockfile blob SHA + importer + the dependency list, so an
 * unchanged lockfile (up to 20 MiB) is neither downloaded nor parsed again.
 */
export interface LockfileCache {
  get(key: string): Promise<LockfileVersions | null>;
  set(key: string, value: LockfileVersions): Promise<void>;
}

export const BLOB_CACHE_TTL_SECONDS = 7 * 24 * 3600;

export function lockfileCacheKey(
  lockfileSha: string,
  importer: string,
  dependencies: ReadonlyArray<{ name: string; declared: string }>,
): string {
  const digest = createHash("sha1")
    .update(JSON.stringify([importer, dependencies.map((d) => [d.name, d.declared])]))
    .digest("hex");
  return `${lockfileSha}-${digest}`;
}

export function createRedisBlobCache(redis: CacheRedis): BlobCache {
  return {
    async get(sha) {
      try {
        return await redis.get(`deps:blob:${sha}`);
      } catch {
        return null;
      }
    },
    async set(sha, text) {
      if (text.length > MAX_MANIFEST_BYTES) return;
      try {
        await redis.set(`deps:blob:${sha}`, text, "EX", BLOB_CACHE_TTL_SECONDS);
      } catch {
        // best effort
      }
    },
  };
}

export function createRedisLockfileCache(redis: CacheRedis): LockfileCache {
  return {
    async get(key) {
      try {
        const raw = await redis.get(`deps:lockread:${key}`);
        if (!raw) return null;
        const data = JSON.parse(raw) as { versions: Array<[string, string]>; formatVersion: string | null; warnings: string[] };
        return { versions: new Map(data.versions), formatVersion: data.formatVersion, warnings: data.warnings };
      } catch {
        return null;
      }
    },
    async set(key, value) {
      try {
        const data = { versions: [...value.versions], formatVersion: value.formatVersion, warnings: value.warnings };
        await redis.set(`deps:lockread:${key}`, JSON.stringify(data), "EX", BLOB_CACHE_TTL_SECONDS);
      } catch {
        // best effort
      }
    },
  };
}
