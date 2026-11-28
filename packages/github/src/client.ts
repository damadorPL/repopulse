import { retry } from "@octokit/plugin-retry";
import { Octokit } from "@octokit/rest";

export const GITHUB_USER_AGENT = "RepoPulse-Coolify/2.0";
export const DEFAULT_GITHUB_RETRIES = 2;
export const DO_NOT_RETRY_STATUSES = [400, 401, 403, 404, 422];

const ResilientOctokit = Octokit.plugin(retry);

/** Instantiates the retry-enabled Octokit client while keeping the return type as standard {@link Octokit}. */
export function instantiateOctokit(options: ConstructorParameters<typeof Octokit>[0]): Octokit {
  return new ResilientOctokit(options);
}

export interface CreateOctokitOptions {
  /** GitHub OAuth / personal access token. Unauthenticated requests get 60 req/h. */
  accessToken?: string | null | undefined;
  /** Custom fetch implementation (used by tests). */
  fetch?: typeof globalThis.fetch | undefined;
  /** Per-attempt request timeout in milliseconds (composed with `signal` when provided). */
  timeoutMs?: number | undefined;
  /** Abort signal applied to requests made by this client. */
  signal?: AbortSignal | undefined;
  /** Retry attempts for transient failures (defaults to 2 in production, 0 when custom `fetch` is passed). */
  retries?: number | undefined;
  /** Base backoff in ms used by `@octokit/plugin-retry` (defaults to 1000). */
  retryAfterBaseValue?: number | undefined;
}

const noop = () => {};

/** Wraps `baseFetch` with a client-level `signal` and/or per-attempt `timeoutMs` via `AbortSignal.any`. */
export function wrapFetchWithSignal(
  baseFetch: typeof globalThis.fetch,
  options: { timeoutMs?: number; signal?: AbortSignal },
): typeof globalThis.fetch {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new RangeError("timeoutMs must be a positive finite number.");
  }
  if (options.timeoutMs === undefined && options.signal === undefined) {
    return baseFetch;
  }
  return (input, init) => {
    const signals: AbortSignal[] = [];
    if (options.signal) signals.push(options.signal);
    if (init?.signal) signals.push(init.signal);
    if (options.timeoutMs !== undefined) signals.push(AbortSignal.timeout(options.timeoutMs));
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    return baseFetch(input, { ...init, ...(signal !== undefined ? { signal } : {}) });
  };
}

/**
 * Creates an Octokit REST client with the RepoPulse user agent and `@octokit/plugin-retry`.
 *
 * Octokit's request-log plugin reports every non-2xx response via `log.error`, which
 * would print a line for every `304 Not Modified` poll. Errors are always re-thrown
 * to the caller, so error/info/debug logging is silenced here and callers log what matters.
 */
export function createOctokit(options: CreateOctokitOptions = {}): Octokit {
  const retries = options.retries ?? (options.fetch ? 0 : DEFAULT_GITHUB_RETRIES);
  const needsWrappedFetch =
    options.fetch !== undefined || options.timeoutMs !== undefined || options.signal !== undefined;
  const fetchFn = needsWrappedFetch
    ? wrapFetchWithSignal(options.fetch ?? globalThis.fetch, {
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
    : undefined;
  return instantiateOctokit({
    auth:
      options.accessToken !== undefined && options.accessToken !== null && options.accessToken.length > 0
        ? options.accessToken
        : undefined,
    userAgent: GITHUB_USER_AGENT,
    log: { debug: noop, info: noop, warn: console.warn.bind(console), error: noop },
    retry: {
      enabled: retries > 0,
      retries,
      doNotRetry: DO_NOT_RETRY_STATUSES,
      ...(options.retryAfterBaseValue !== undefined ? { retryAfterBaseValue: options.retryAfterBaseValue } : {}),
    },
    ...(fetchFn ? { request: { fetch: fetchFn } } : {}),
  });
}

type HeaderValue = string | number | string[] | undefined | null;
export type ResponseHeaders = Record<string, HeaderValue>;

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
}

function headerNumber(headers: ResponseHeaders | undefined, name: string): number | null {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Reads GitHub's `x-ratelimit-*` headers from a response (or error response). */
export function getRateLimitInfo(headers: ResponseHeaders | undefined): RateLimitInfo {
  const reset = headerNumber(headers, "x-ratelimit-reset");
  return {
    limit: headerNumber(headers, "x-ratelimit-limit"),
    remaining: headerNumber(headers, "x-ratelimit-remaining"),
    resetAt: reset === null ? null : new Date(reset * 1000),
  };
}

/** Shape of Octokit's `RequestError`, duck-typed so we don't depend on a specific instance. */
export interface GitHubHttpError {
  status: number;
  response?: { headers?: ResponseHeaders };
}

export function isGitHubHttpError(error: unknown): error is GitHubHttpError {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number";
}
