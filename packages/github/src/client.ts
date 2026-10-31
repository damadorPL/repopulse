import { Octokit } from "@octokit/rest";

export const GITHUB_USER_AGENT = "RepoPulse-Coolify/2.0";

export interface CreateOctokitOptions {
  /** GitHub OAuth / personal access token. Unauthenticated requests get 60 req/h. */
  accessToken?: string | null;
  /** Custom fetch implementation (used by tests). */
  fetch?: typeof globalThis.fetch;
}

const noop = () => {};

/**
 * Creates an Octokit REST client with the RepoPulse user agent.
 *
 * Octokit's request-log plugin reports every non-2xx response via `log.error`, which
 * would print a line for every `304 Not Modified` poll. Errors are always re-thrown
 * to the caller, so error/info/debug logging is silenced here and callers log what matters.
 */
export function createOctokit(options: CreateOctokitOptions = {}): Octokit {
  return new Octokit({
    auth: options.accessToken || undefined,
    userAgent: GITHUB_USER_AGENT,
    log: { debug: noop, info: noop, warn: console.warn.bind(console), error: noop },
    ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
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
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  );
}
