import { decryptToken, prisma, type User as DbUser } from "@repopulse/db";
import { createOctokit } from "@repopulse/github";

export interface GitHubQuotaView {
  limit: number;
  remaining: number;
  used: number;
  resetAt: string; // ISO string for server-to-client serialization
  authenticated: boolean;
  login: string | null;
}

export type GitHubQuotaResult =
  | { ok: true; data: GitHubQuotaView }
  | { ok: false; error: string };

export interface GetGitHubQuotaOptions {
  fetch?: typeof globalThis.fetch;
}

function resolveToken(user: DbUser): string | undefined {
  if (!user.githubAccessTokenEncrypted) return undefined;
  try {
    return decryptToken(user.githubAccessTokenEncrypted);
  } catch (error) {
    console.warn(`[github-quota] could not decrypt GitHub token for user ${user.id}`, error);
    return undefined;
  }
}

/**
 * Reads the current GitHub API rate limit for the instance.
 * Prioritizes the signed-in admin's token, falls back to any stored subscriber token,
 * or queries anonymously (60 req/h). Accessing GitHub's /rate_limit endpoint costs zero quota.
 */
export async function getGitHubQuotaView(
  adminUser: DbUser,
  options?: GetGitHubQuotaOptions,
): Promise<GitHubQuotaResult> {
  try {
    let token = resolveToken(adminUser);
    let login = adminUser.githubLogin;

    if (!token) {
      const subscriber = await prisma.user.findFirst({
        where: { githubAccessTokenEncrypted: { not: null } },
        select: { githubAccessTokenEncrypted: true, githubLogin: true },
      });
      if (subscriber?.githubAccessTokenEncrypted) {
        try {
          token = decryptToken(subscriber.githubAccessTokenEncrypted);
          login = subscriber.githubLogin;
        } catch {
          token = undefined;
        }
      }
    }

    const octokit = createOctokit({ accessToken: token, fetch: options?.fetch });
    const response = await octokit.rest.rateLimit.get();
    const rate = response.data.rate;

    return {
      ok: true,
      data: {
        limit: rate.limit,
        remaining: rate.remaining,
        used: rate.used,
        resetAt: new Date(rate.reset * 1000).toISOString(),
        authenticated: Boolean(token),
        login,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch rate limit from GitHub";
    return { ok: false, error: message };
  }
}
