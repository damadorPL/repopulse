import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { encryptToken, INSTANCE_SETTINGS_ID, prisma } from "@repopulse/db";
import { GitHubRateLimitError, type ConvertedAppManifest } from "@repopulse/github";
import type { GitHubAppCallbackError } from "@/lib/github-app";

/**
 * Server-only helpers of Admin → GitHub App (Slice 08 Part B). Not a `"use server"` module: nothing
 * here is callable from the browser, so it can be unit-tested and hold the secret-handling code.
 */

export const GITHUB_APP_ADMIN_PATH = "/admin/github-app";

/**
 * The manifest flow's `state`: a random value in an httpOnly cookie, set by `startGitHubAppManifestAction`
 * right before the browser posts the manifest to GitHub, and compared (constant time) by the callback.
 * `sameSite=lax` is enough: GitHub sends the browser back with a top-level GET. The path limits the
 * cookie to the callback route.
 */
export const GITHUB_APP_STATE_COOKIE = "repopulse_github_app_state";
export const GITHUB_APP_STATE_COOKIE_PATH = "/api/github-app/manifest";
export const GITHUB_APP_STATE_MAX_AGE_SECONDS = 10 * 60;

export function githubAppStateCookieOptions(maxAge = GITHUB_APP_STATE_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: GITHUB_APP_STATE_COOKIE_PATH,
    maxAge,
  };
}

export function createManifestState(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time comparison of the cookie and the `state` query parameter (hashed first, so lengths don't leak). */
export function statesMatch(expected: string | undefined | null, received: string | undefined | null): boolean {
  if (!expected || !received) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(received).digest();
  return timingSafeEqual(a, b);
}

/** Stores a freshly created App: id, slug, client id, owner, and the encrypted key and webhook secret. */
export async function saveConvertedApp(app: Pick<ConvertedAppManifest, "id" | "slug" | "clientId" | "owner" | "pem" | "webhookSecret">): Promise<void> {
  const data = {
    githubAppId: app.id,
    githubAppSlug: app.slug,
    githubAppClientId: app.clientId,
    githubAppOwner: app.owner,
    githubAppPrivateKeyEncrypted: encryptToken(app.pem),
    githubAppWebhookSecretEncrypted: app.webhookSecret ? encryptToken(app.webhookSecret) : null,
  };
  await prisma.instanceSettings.upsert({ where: { id: INSTANCE_SETTINGS_ID }, create: { id: INSTANCE_SETTINGS_ID, ...data }, update: data });
}

export interface ManifestCallbackInput {
  code: string | null;
  state: string | null;
  cookieState: string | undefined;
}

export interface ManifestCallbackDeps {
  convert: (code: string) => Promise<ConvertedAppManifest>;
  save: (app: ConvertedAppManifest) => Promise<void>;
}

function errorPath(code: GitHubAppCallbackError): string {
  return `${GITHUB_APP_ADMIN_PATH}?error=${code}`;
}

/**
 * The manifest callback after the super admin check: verifies `state`, exchanges the code and stores
 * the App. Returns where to redirect. Never throws, and never puts anything from GitHub's answer
 * (or the error) in the URL: only a fixed error code.
 */
export async function completeManifestCallback(input: ManifestCallbackInput, deps: ManifestCallbackDeps): Promise<string> {
  if (!statesMatch(input.cookieState, input.state)) return errorPath("state");
  const code = input.code?.trim();
  if (!code) return errorPath("code");
  let app: ConvertedAppManifest;
  try {
    app = await deps.convert(code);
  } catch (error) {
    if (error instanceof GitHubRateLimitError) return errorPath("rate_limited");
    console.warn("[github-app] manifest conversion failed", error instanceof Error ? error.message : error);
    return errorPath("conversion");
  }
  try {
    await deps.save(app);
  } catch (error) {
    console.error("[github-app] could not store the GitHub App", error instanceof Error ? error.message : error);
    return errorPath("unknown");
  }
  return `${GITHUB_APP_ADMIN_PATH}?created=1`;
}
