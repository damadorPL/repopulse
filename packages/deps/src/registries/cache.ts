/**
 * Registry response cache and the shared conditional GET. The worker backs {@link RegistryCache} with Redis;
 * {@link createMemoryRegistryCache} serves tests and single-process use.
 */
import { REGISTRY_CACHE_TTL_MS, REGISTRY_CONCURRENCY } from "../limits.js";

export interface RegistryCacheEntry {
  /** `ETag` of the upstream response, for `If-None-Match` once the entry is stale. */
  etag?: string;
  /** Cached (compacted) body. */
  body: string;
  /** `Date.now()` when stored or last revalidated. Fresh while younger than {@link REGISTRY_CACHE_TTL_MS}. */
  storedAt: number;
}

export interface RegistryCache {
  get(key: string): Promise<RegistryCacheEntry | null>;
  /** `retentionMs`: how long to keep the entry (longer than the TTL, so stale entries can be revalidated). */
  set(key: string, entry: RegistryCacheEntry, retentionMs: number): Promise<void>;
}

/** How long the cache keeps an entry: stale entries past the TTL are still revalidated with their ETag. */
export const REGISTRY_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type RegistryCacheNamespace = "npm" | "npm-time" | "pypi" | "pypi-meta";

/** `deps:reg:<eco>:<name>`. */
export function registryCacheKey(namespace: RegistryCacheNamespace, name: string): string {
  return `deps:reg:${namespace}:${name}`;
}

/** In-memory cache (Map), honouring the retention. */
export function createMemoryRegistryCache(now: () => number = Date.now): RegistryCache & { size(): number } {
  const entries = new Map<string, { entry: RegistryCacheEntry; expiresAt: number }>();
  return {
    async get(key) {
      const found = entries.get(key);
      if (!found) return null;
      if (found.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return found.entry;
    },
    async set(key, entry, retentionMs) {
      entries.set(key, { entry, expiresAt: now() + retentionMs });
    },
    size: () => entries.size,
  };
}

/** A 429 / 5xx / network failure: the scan job should be retried with backoff, keeping the previous results. */
export class RegistryUnavailableError extends Error {
  constructor(
    readonly registry: "npm" | "pypi",
    readonly status: number | null,
    message: string,
    /** From `Retry-After`, when present. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "RegistryUnavailableError";
  }
}

export function isRegistryUnavailableError(error: unknown): error is RegistryUnavailableError {
  return error instanceof RegistryUnavailableError;
}

export interface RegistryFetchOptions {
  /** Injected `fetch` (global `fetch` in production). */
  fetch: typeof fetch;
  cache?: RegistryCache | null;
  /** Clock, for tests. */
  now?: () => number;
  /** Freshness window; defaults to {@link REGISTRY_CACHE_TTL_MS}. */
  ttlMs?: number;
  signal?: AbortSignal;
  userAgent?: string;
}

export const REGISTRY_USER_AGENT = "RepoPulse-Deps/1.0";

function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export type CachedGetResult = { found: true; body: string; fromCache: boolean } | { found: false; status: number };

/**
 * Conditional GET through the cache: a fresh entry is returned as is; a stale one is revalidated with
 * `If-None-Match` (304 refreshes it). `derive` compacts a 200 body before it is cached and returned.
 * 404 / 410 / other 4xx → `{ found: false }`; 429, 5xx and network errors throw {@link RegistryUnavailableError}.
 */
export async function cachedGet(params: {
  registry: "npm" | "pypi";
  url: string;
  accept: string;
  key: string;
  options: RegistryFetchOptions;
  derive?: (body: string) => string;
}): Promise<CachedGetResult> {
  const { registry, url, accept, key, options } = params;
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? REGISTRY_CACHE_TTL_MS;
  const cached = options.cache ? await options.cache.get(key) : null;
  if (cached && now() - cached.storedAt < ttl) return { found: true, body: cached.body, fromCache: true };

  const headers: Record<string, string> = { Accept: accept, "User-Agent": options.userAgent ?? REGISTRY_USER_AGENT };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  let response: Response;
  try {
    response = await options.fetch(url, { headers, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new RegistryUnavailableError(registry, null, `${registry} registry unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 304 && cached) {
    await options.cache?.set(key, { ...cached, storedAt: now() }, REGISTRY_CACHE_RETENTION_MS);
    return { found: true, body: cached.body, fromCache: true };
  }
  if (response.status === 429 || response.status >= 500) {
    throw new RegistryUnavailableError(
      registry,
      response.status,
      `${registry} registry responded ${response.status}`,
      retryAfterMs(response.headers.get("retry-after"), now()),
    );
  }
  if (!response.ok) return { found: false, status: response.status };
  const raw = await response.text();
  let body: string;
  try {
    body = params.derive ? params.derive(raw) : raw;
  } catch (error) {
    throw new RegistryUnavailableError(registry, response.status, `${registry} registry sent an unreadable response (${error instanceof Error ? error.message : String(error)})`);
  }
  const etag = response.headers.get("etag");
  await options.cache?.set(key, { ...(etag ? { etag } : {}), body, storedAt: now() }, REGISTRY_CACHE_RETENTION_MS);
  return { found: true, body, fromCache: false };
}

/** Limits concurrent async work (default {@link REGISTRY_CONCURRENCY} in flight). */
export function createLimiter(concurrency: number = REGISTRY_CONCURRENCY): <T>(task: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be a positive integer");
  let active = 0;
  const queue: Array<() => void> = [];
  const next = (): void => {
    active--;
    queue.shift()?.();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      next();
    }
  };
}

/** `Promise.all(items.map(fn))` with at most `concurrency` calls in flight; results keep the input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number = REGISTRY_CONCURRENCY,
): Promise<R[]> {
  const limit = createLimiter(concurrency);
  return Promise.all(items.map((item, index) => limit(() => fn(item, index))));
}
