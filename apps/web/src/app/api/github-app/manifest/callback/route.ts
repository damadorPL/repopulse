import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { convertAppManifest } from "@repopulse/github";
import { getCurrentUserOrThrow, UnauthorizedError } from "@/lib/auth";
import { completeManifestCallback, GITHUB_APP_STATE_COOKIE, githubAppStateCookieOptions, saveConvertedApp } from "@/server/github-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/github-app/manifest/callback?code=…&state=…: GitHub sends the super admin here after
 * creating the App from the manifest (Admin → GitHub App). Super admin only (404 for everyone else).
 * The `state` must match the httpOnly cookie set by `startGitHubAppManifestAction`; the cookie is
 * single-use and cleared here. The code is exchanged for the App's credentials, which are stored
 * encrypted, then the browser goes back to the admin page with `?created=1` or `?error=<code>`.
 */
export async function GET(request: NextRequest): Promise<Response> {
  let isSuperAdmin = false;
  try {
    isSuperAdmin = (await getCurrentUserOrThrow()).isSuperAdmin;
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    redirect("/login");
  }
  if (!isSuperAdmin) notFound();

  const cookieStore = await cookies();
  const cookieState = cookieStore.get(GITHUB_APP_STATE_COOKIE)?.value;
  // Single use: cleared whatever the outcome (same path and flags as when it was set).
  cookieStore.set(GITHUB_APP_STATE_COOKIE, "", githubAppStateCookieOptions(0));

  const params = request.nextUrl.searchParams;
  const target = await completeManifestCallback(
    { code: params.get("code"), state: params.get("state"), cookieState },
    { convert: (code) => convertAppManifest(code), save: saveConvertedApp },
  );
  redirect(target);
}
