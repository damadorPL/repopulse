import type { z } from "zod";
import { decryptToken, type User as DbUser } from "@repopulse/db";
import { GitHubRateLimitError, GitHubRepositoryNotFoundError, InvalidRepositoryInputError } from "@repopulse/github";
import { UnauthorizedError } from "@/lib/auth";

/**
 * Shared result plumbing for Server Actions. Thrown errors are redacted in production,
 * so actions return a serializable `ActionResult` instead.
 */

export type ActionErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  /** A notification channel refused or did not answer ("Send Test"). */
  | "DELIVERY_FAILED"
  | "INTERNAL";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ActionErrorCode; message: string } };

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function fail(code: ActionErrorCode, message: string): ActionResult<never> {
  return { ok: false, error: { code, message } };
}

export function invalidInput(error: z.ZodError): ActionResult<never> {
  return fail("INVALID_INPUT", error.issues[0]?.message ?? "Invalid input");
}

/** Prisma unique-constraint violation (duck-typed so it doesn't depend on error class identity). */
export function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

/** Maps known errors to results; logs and hides everything else. */
export function toActionError(error: unknown, action: string): ActionResult<never> {
  if (error instanceof UnauthorizedError) return fail("UNAUTHORIZED", error.message);
  if (error instanceof InvalidRepositoryInputError) return fail("INVALID_INPUT", error.message);
  if (error instanceof GitHubRepositoryNotFoundError) return fail("NOT_FOUND", error.message);
  if (error instanceof GitHubRateLimitError) return fail("RATE_LIMITED", error.message);
  console.error(`[${action}] unexpected error`, error);
  return fail("INTERNAL", "Something went wrong. Please try again.");
}

/** Returns the user's GitHub token, or undefined (unauthenticated, 60 req/h) if it can't be decrypted. */
export function getGitHubToken(user: DbUser, action: string): string | undefined {
  if (!user.githubAccessTokenEncrypted) return undefined;
  try {
    return decryptToken(user.githubAccessTokenEncrypted);
  } catch (error) {
    // e.g. TOKEN_ENCRYPTION_KEY rotated — the next sign-in re-encrypts with the new key.
    console.warn(`[${action}] could not decrypt GitHub token for user ${user.id}`, error);
    return undefined;
  }
}
