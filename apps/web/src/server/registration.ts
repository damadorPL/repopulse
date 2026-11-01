import { prisma } from "@repopulse/db";
import { isWellFormedInviteToken } from "@/lib/invites";
import { hashInviteToken } from "@/server/invite-tokens";

/** `true` unless an admin turned public sign-up off. A missing settings row means the default. */
export async function isPublicRegistrationOpen(): Promise<boolean> {
  const settings = await prisma.instanceSettings.findUnique({ where: { id: 1 }, select: { publicRegistration: true } });
  return settings?.publicRegistration ?? true;
}

/** An unused, unexpired invite for this raw token, or null. */
export async function findUsableInvite(token: string) {
  if (!isWellFormedInviteToken(token)) return null;
  return prisma.invite.findFirst({
    where: { tokenHash: hashInviteToken(token), usedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, expiresAt: true, createdBy: { select: { name: true, email: true } } },
  });
}

/** Where a refused sign-in lands. */
export const INVITE_REQUIRED_REDIRECT = "/login?error=InviteRequired";
export const INVITE_INVALID_REDIRECT = "/login?error=InviteInvalid";

/** Profile data for a new `User` row, taken from the GitHub sign-in. */
export interface GitHubUserFields {
  githubId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  githubAccessTokenEncrypted: string;
}

class InviteUnavailableError extends Error {}

/**
 * Registration gate for a GitHub sign-in (Auth.js `signIn` callback).
 *
 * - Existing users always get in.
 * - The very first account is created here as admin (fresh install).
 * - With an invite token, the invite is claimed and the account created in one transaction,
 *   so a link can't be used twice.
 * - Otherwise new accounts need public registration to be on (the `jwt` callback creates them).
 *
 * Returns `true` to continue, or a path to redirect to.
 */
export async function admitGitHubUser(
  fields: GitHubUserFields,
  inviteToken: string | undefined,
): Promise<true | string> {
  const existing = await prisma.user.findUnique({ where: { githubId: fields.githubId }, select: { id: true } });
  if (existing) return true;

  const [userCount, publicRegistration] = await Promise.all([prisma.user.count(), isPublicRegistrationOpen()]);
  if (userCount === 0) {
    await prisma.user.create({ data: { ...fields, isAdmin: true } });
    return true;
  }

  if (inviteToken && isWellFormedInviteToken(inviteToken)) {
    const tokenHash = hashInviteToken(inviteToken);
    try {
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        const { count } = await tx.invite.updateMany({
          where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (count !== 1) throw new InviteUnavailableError();
        const user = await tx.user.create({ data: fields, select: { id: true } });
        await tx.invite.update({ where: { tokenHash }, data: { usedById: user.id } });
      });
      return true;
    } catch (error) {
      if (!(error instanceof InviteUnavailableError)) throw error;
      // Used / expired / revoked link: fine while sign-up is open anyway.
      return publicRegistration ? true : INVITE_INVALID_REDIRECT;
    }
  }

  return publicRegistration ? true : INVITE_REQUIRED_REDIRECT;
}
