import { createHash } from "node:crypto";
import {
  MAX_MANIFEST_BYTES,
  type LockfileVersions,
  type RegistryCache,
  type RegistryCacheEntry,
} from "@repopulse/deps";
import type { GitTreeEntry } from "@repopulse/github";
import type { Redis } from "@repopulse/queue";
import { createLogger } from "./logger.js";

const log = createLogger("deps-cache");

type CacheRedis = Pick<Redis, "get" | "set">;
type BlobCacheRedis = CacheRedis & Partial<Pick<Redis, "mget" | "pipeline">>;

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
        return {
          body: entry.body,
          storedAt: entry.storedAt,
          ...(typeof entry.etag === "string" ? { etag: entry.etag } : {}),
        };
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
  getMany?(shas: readonly string[]): Promise<Map<string, string>>;
  setMany?(entries: ReadonlyArray<{ sha: string; text: string }>): Promise<void>;
}

/**
 * Lockfile read results (`readLockfile` output) keyed by lockfile blob SHA + importer + the dependency list, so an
 * unchanged lockfile (up to 20 MiB) is neither downloaded nor parsed again.
 */
export interface LockfileCache {
  get(key: string): Promise<LockfileVersions | null>;
  set(key: string, value: LockfileVersions): Promise<void>;
}

export interface CachedGitTree {
  entries: GitTreeEntry[];
  truncated: boolean;
}

/**
 * Git tree snapshot cache keyed by `(githubRepoId, commitSha)` so scans whose default branch HEAD
 * (`knownCommitSha`) has not moved skip `GET /git/trees/{sha}?recursive=1` completely.
 */
export interface TreeCache {
  get(githubRepoId: number, commitSha: string): Promise<CachedGitTree | null>;
  set(githubRepoId: number, commitSha: string, value: CachedGitTree): Promise<void>;
}

export const BLOB_CACHE_TTL_SECONDS = 7 * 24 * 3600;
export const TREE_CACHE_TTL_SECONDS = 24 * 3600;
export const MAX_TREE_CACHE_BYTES = 2 * 1024 * 1024;
export const LOCKFILE_CACHE_VERSION = 2;

export function lockfileCacheKey(
  lockfileSha: string,
  importer: string,
  dependencies: ReadonlyArray<{ name: string; declared: string }>,
): string {
  const digest = createHash("sha1")
    .update(JSON.stringify([LOCKFILE_CACHE_VERSION, importer, dependencies.map((d) => [d.name, d.declared])]))
    .digest("hex");
  return `${lockfileSha}-${digest}`;
}

export function createRedisBlobCache(redis: BlobCacheRedis): BlobCache {
  const get = async (sha: string): Promise<string | null> => {
    try {
      return await redis.get(`deps:blob:${sha}`);
    } catch {
      return null;
    }
  };
  const set = async (sha: string, text: string): Promise<void> => {
    if (text.length > MAX_MANIFEST_BYTES) return;
    try {
      await redis.set(`deps:blob:${sha}`, text, "EX", BLOB_CACHE_TTL_SECONDS);
    } catch {
      // best effort
    }
  };

  return {
    get,
    set,
    async getMany(shas) {
      const unique = [...new Set(shas)];
      const hits = new Map<string, string>();
      if (unique.length === 0) return hits;
      try {
        if (typeof redis.mget === "function") {
          const values = await redis.mget(...unique.map((sha) => `deps:blob:${sha}`));
          for (const [index, sha] of unique.entries()) {
            const value = values[index];
            if (typeof value === "string") hits.set(sha, value);
          }
          return hits;
        }
        const values = await Promise.all(unique.map((sha) => get(sha)));
        for (const [index, sha] of unique.entries()) {
          const value = values[index];
          if (value !== null && value !== undefined) hits.set(sha, value);
        }
      } catch {
        // best effort
      }
      return hits;
    },
    async setMany(entries) {
      const eligible = entries.filter((entry) => entry.text.length <= MAX_MANIFEST_BYTES);
      if (eligible.length === 0) return;
      try {
        if (typeof redis.pipeline === "function") {
          const pipeline = redis.pipeline();
          for (const entry of eligible) {
            pipeline.set(`deps:blob:${entry.sha}`, entry.text, "EX", BLOB_CACHE_TTL_SECONDS);
          }
          await pipeline.exec();
          return;
        }
        await Promise.all(eligible.map((entry) => set(entry.sha, entry.text)));
      } catch {
        // best effort
      }
    },
  };
}

export function createRedisTreeCache(redis: CacheRedis): TreeCache {
  return {
    async get(githubRepoId, commitSha) {
      try {
        const raw = await redis.get(`deps:tree:${githubRepoId}:${commitSha}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<CachedGitTree>;
        if (!Array.isArray(parsed.entries) || typeof parsed.truncated !== "boolean") return null;
        return { entries: parsed.entries, truncated: parsed.truncated };
      } catch {
        return null;
      }
    },
    async set(githubRepoId, commitSha, value) {
      try {
        const serialized = JSON.stringify(value);
        if (Buffer.byteLength(serialized, "utf8") > MAX_TREE_CACHE_BYTES) return;
        await redis.set(`deps:tree:${githubRepoId}:${commitSha}`, serialized, "EX", TREE_CACHE_TTL_SECONDS);
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
        const data = JSON.parse(raw) as {
          versions: Array<[string, string]>;
          formatVersion: string | null;
          warnings: string[];
        };
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
