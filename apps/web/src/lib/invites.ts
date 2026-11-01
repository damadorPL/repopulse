/** Invite constants and helpers shared by client and server (token hashing lives in `@/server/invite-tokens`). */

/** httpOnly cookie that carries an invite token from `/invite/<token>` through the GitHub OAuth round trip. */
export const INVITE_COOKIE = "repopulse_invite";
/** The cookie only needs to survive the OAuth round trip. */
export const INVITE_COOKIE_MAX_AGE_SECONDS = 60 * 60;

export const INVITE_EXPIRY_DAYS = [1, 7, 30] as const;
export type InviteExpiryDays = (typeof INVITE_EXPIRY_DAYS)[number];
export const INVITE_NOTE_MAX_LENGTH = 80;
/** Most pending (unused, unexpired) invites at once. */
export const MAX_PENDING_INVITES = 50;

/** Cheap shape check so junk tokens never reach the database. */
export function isWellFormedInviteToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export type InviteStatus = "pending" | "used" | "expired";

export function inviteStatus(invite: { usedAt: Date | null; expiresAt: Date }, now = new Date()): InviteStatus {
  if (invite.usedAt) return "used";
  return invite.expiresAt.getTime() > now.getTime() ? "pending" : "expired";
}
