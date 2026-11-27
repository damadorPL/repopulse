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

/** Default per-request HTTP timeout for registry fetches (15 seconds). */
export const DEFAULT_REGISTRY_TIMEOUT_MS = 15_000;

/** Default maximum registry response body size in bytes (25 MiB). */
export const DEFAULT_REGISTRY_MAX_BYTES = 25 * 1024 * 1024;

/** Default maximum entries in {@link createMemoryRegistryCache}. */
export const DEFAULT_MEMORY_CACHE_MAX_ENTRIES = 1000;

export type RegistryCacheNamespace = "npm" | "npm-time" | "pypi" | "pypi-meta";

/** `deps:reg:<eco>:<name>`. */
export function registryCacheKey(namespace: RegistryCacheNamespace, name: string): string {
  return `deps:reg:${namespace}:${name}`;
}

/** In-memory bounded LRU cache (Map), honouring retention and evicting least-recently-used entries. */
export function createMemoryRegistryCache(
  now: () => number = Date.now,
  maxEntries: number = DEFAULT_MEMORY_CACHE_MAX_ENTRIES,
): RegistryCache & { size(): number } {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("maxEntries must be a positive integer");
  }
  const entries = new Map<string, { entry: RegistryCacheEntry; expiresAt: number }>();
  return {
    async get(key) {
      const found = entries.get(key);
      if (!found) return null;
      if (found.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, found);
      return found.entry;
    },
    async set(key, entry, retentionMs) {
      if (entries.has(key)) entries.delete(key);
      entries.set(key, { entry, expiresAt: now() + retentionMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    size: () => entries.size,
  };
}

/** A 429 / 5xx / network failure: the scan job should be retried with backoff, keeping the previous results. */
export class RegistryUnavailableError extends Error {
  readonly registry: "npm" | "pypi";
  readonly status: number | null;
  /** From `Retry-After`, when present. */
  readonly retryAfterMs: number | null;

  constructor(registry: "npm" | "pypi", status: number | null, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "RegistryUnavailableError";
    this.registry = registry;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
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
  /** Request timeout in milliseconds; defaults to {@link DEFAULT_REGISTRY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Maximum response body size in bytes; defaults to {@link DEFAULT_REGISTRY_MAX_BYTES}. */
  maxBytes?: number;
  signal?: AbortSignal;
  userAgent?: string;
}

export const REGISTRY_USER_AGENT = "RepoPulse-Deps/1.0";

const inFlightByScope = new WeakMap<object, Map<string, Promise<CachedGetResult>>>();
const signalIds = new WeakMap<AbortSignal, number>();
let nextSignalId = 1;

function getSignalId(signal: AbortSignal | undefined): number {
  if (!signal) return 0;
  let id = signalIds.get(signal);
  if (id === undefined) {
    id = nextSignalId++;
    signalIds.set(signal, id);
  }
  return id;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore already-closed or locked body streams.
  }
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await cancelResponseBody(response);
      throw new Error(`response exceeded ${maxBytes} byte limit (${declared} bytes declared)`);
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`response exceeded ${maxBytes} byte limit`);
    }
    return text;
  }

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`response exceeded ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

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
 * Concurrent calls for the same key/URL/scope share a single in-flight HTTP fetch.
 * 404 / 410 / other 4xx → `{ found: false }`; 429, 5xx, oversized bodies and network/timeout errors
 * throw {@link RegistryUnavailableError}.
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_REGISTRY_MAX_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive finite number");
  }

  const cached = options.cache ? await options.cache.get(key) : null;
  if (cached && now() - cached.storedAt < ttl) return { found: true, body: cached.body, fromCache: true };

  const execute = async (): Promise<CachedGetResult> => {
    const headers: Record<string, string> = { Accept: accept, "User-Agent": options.userAgent ?? REGISTRY_USER_AGENT };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await options.fetch(url, { headers, signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new RegistryUnavailableError(
        registry,
        null,
        `${registry} registry unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (response.status === 304 && cached) {
      await cancelResponseBody(response);
      await options.cache?.set(key, { ...cached, storedAt: now() }, REGISTRY_CACHE_RETENTION_MS);
      return { found: true, body: cached.body, fromCache: true };
    }
    if (response.status === 429 || response.status >= 500) {
      await cancelResponseBody(response);
      throw new RegistryUnavailableError(
        registry,
        response.status,
        `${registry} registry responded ${response.status}`,
        retryAfterMs(response.headers.get("retry-after"), now()),
      );
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      return { found: false, status: response.status };
    }

    let raw: string;
    try {
      raw = await readResponseTextWithLimit(response, maxBytes);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new RegistryUnavailableError(
        registry,
        response.status,
        `${registry} registry sent an unreadable response (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    let body: string;
    try {
      body = params.derive ? params.derive(raw) : raw;
    } catch (error) {
      throw new RegistryUnavailableError(
        registry,
        response.status,
        `${registry} registry sent an unreadable response (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const etag = response.headers.get("etag");
    await options.cache?.set(key, { ...(etag ? { etag } : {}), body, storedAt: now() }, REGISTRY_CACHE_RETENTION_MS);
    return { found: true, body, fromCache: false };
  };

  if (options.signal?.aborted) return execute();

  const scope: object = options.cache ?? options.fetch;
  let inFlight = inFlightByScope.get(scope);
  if (!inFlight) {
    inFlight = new Map();
    inFlightByScope.set(scope, inFlight);
  }
  const flightKey = `${getSignalId(options.signal)}\0${key}\0${url}\0${accept}\0${ttl}`;
  const existing = inFlight.get(flightKey);
  if (existing) return existing;

  const promise = execute().finally(() => {
    inFlight.delete(flightKey);
  });
  inFlight.set(flightKey, promise);
  return promise;
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
