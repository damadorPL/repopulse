import { decryptToken, type PrismaClient } from "@repopulse/db";
import { createLogger } from "../logger";

const log = createLogger("github-tokens");

/** Subscriber tokens tried (most recently signed-in first) before falling back to anonymous. */
export const MAX_TOKEN_CANDIDATES = 3;

export type TokenCandidate = { userId: string | null; token: string | undefined };

/**
 * Up to {@link MAX_TOKEN_CANDIDATES} decryptable subscriber tokens, so the request uses an
 * authenticated 5,000 req/h quota. The user who clicked "Sync now" goes first (their own
 * quota pays for it). Anonymous access (60 req/h) is the last resort.
 */
export async function tokenCandidates(
  prisma: PrismaClient,
  repositoryId: string,
  preferredUserId: string | undefined,
): Promise<TokenCandidate[]> {
  const subscriptions = await prisma.userSubscription.findMany({
    where: { repositoryId, user: { githubAccessTokenEncrypted: { not: null } } },
    select: { userId: true, user: { select: { githubAccessTokenEncrypted: true } } },
    orderBy: { user: { updatedAt: "desc" } },
    take: MAX_TOKEN_CANDIDATES + 1,
  });
  subscriptions.sort((a, b) => Number(b.userId === preferredUserId) - Number(a.userId === preferredUserId));

  const candidates: TokenCandidate[] = [];
  for (const { userId, user } of subscriptions) {
    if (candidates.length === MAX_TOKEN_CANDIDATES) break;
    try {
      candidates.push({ userId, token: decryptToken(user.githubAccessTokenEncrypted!) });
    } catch {
      // e.g. TOKEN_ENCRYPTION_KEY rotated; the user's next sign-in re-encrypts it.
      log.warn(`could not decrypt the GitHub token of user ${userId}; skipping it`);
    }
  }
  candidates.push({ userId: null, token: undefined });
  return candidates;
}
