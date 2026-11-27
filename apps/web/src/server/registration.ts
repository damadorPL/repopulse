import { INSTANCE_SETTINGS_ID, prisma, type Prisma } from "@repopulse/db";
import { isWellFormedInviteToken } from "@/lib/invites";
import { hashInviteToken } from "@/server/invite-tokens";

export interface RegistrationDbClient {
  user: Pick<Prisma.TransactionClient["user"], "count">;
  instanceSettings: Pick<Prisma.TransactionClient["instanceSettings"], "findUnique">;
  invite: Pick<Prisma.TransactionClient["invite"], "updateMany">;
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
}

/** `true` unless the super admin turned public sign-up off. A missing settings row means the default. */
export async function isPublicRegistrationOpen(
  db: Pick<RegistrationDbClient, "instanceSettings"> = prisma,
): Promise<boolean> {
  const settings = await db.instanceSettings.findUnique({
    where: { id: INSTANCE_SETTINGS_ID },
    select: { publicRegistration: true },
  });
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

export type RegistrationAdmission =
  | { admitted: true; isSuperAdmin: boolean; claimedInviteTokenHash: string | null }
  | { admitted: false; errorCode: "InviteRequired" | "InviteInvalid"; redirectTo: string };

async function runAdmissionInTx(
  tx: RegistrationDbClient,
  inviteToken: string | undefined,
): Promise<RegistrationAdmission> {
  // Serialize bootstrap across web processes: two initial OAuth callbacks must not
  // both observe an empty instance and acquire administrator privileges.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(724512, 1)`;
  if ((await tx.user.count()) === 0) {
    return { admitted: true, isSuperAdmin: true, claimedInviteTokenHash: null };
  }

  const publicRegistration = await isPublicRegistrationOpen(tx);

  if (inviteToken && isWellFormedInviteToken(inviteToken)) {
    const tokenHash = hashInviteToken(inviteToken);
    const now = new Date();
    const { count } = await tx.invite.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count === 1) {
      return { admitted: true, isSuperAdmin: false, claimedInviteTokenHash: tokenHash };
    }
    // Used / expired / revoked link: fine while sign-up is open anyway.
    return publicRegistration
      ? { admitted: true, isSuperAdmin: false, claimedInviteTokenHash: null }
      : { admitted: false, errorCode: "InviteInvalid", redirectTo: INVITE_INVALID_REDIRECT };
  }

  return publicRegistration
    ? { admitted: true, isSuperAdmin: false, claimedInviteTokenHash: null }
    : { admitted: false, errorCode: "InviteRequired", redirectTo: INVITE_REQUIRED_REDIRECT };
}

/**
 * Registration gate for a brand-new GitHub user (`databaseHooks.user.create.before`).
 *
 * - The very first account becomes the super admin (fresh install), serialized with
 *   `pg_advisory_xact_lock(724512, 1)` on the active user-creation transaction.
 * - With a valid invite token, claims the invite atomically inside the same transaction
 *   (and `databaseHooks.account.create.before` sets `usedById` once the user row exists).
 * - Otherwise new accounts need public registration to be enabled.
 */
export async function admitNewGitHubUser(
  inviteToken: string | undefined,
  tx?: RegistrationDbClient,
): Promise<RegistrationAdmission> {
  if (tx) {
    return runAdmissionInTx(tx, inviteToken);
  }
  return prisma.$transaction((innerTx) => runAdmissionInTx(innerTx, inviteToken));
}
