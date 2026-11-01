import { prisma } from "@repopulse/db";
import { inviteStatus, type InviteStatus } from "@/lib/invites";

/** An invite as the Access settings page sees it (never includes the token). */
export interface InviteView {
  id: string;
  note: string | null;
  status: InviteStatus;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  createdBy: string;
  usedBy: { name: string | null; email: string; avatarUrl: string | null } | null;
}

export const inviteSelect = {
  id: true,
  note: true,
  expiresAt: true,
  usedAt: true,
  createdAt: true,
  createdBy: { select: { name: true, email: true } },
  usedBy: { select: { name: true, email: true, avatarUrl: true } },
} as const;

export function toInviteView(
  invite: {
    id: string;
    note: string | null;
    expiresAt: Date;
    usedAt: Date | null;
    createdAt: Date;
    createdBy: { name: string | null; email: string };
    usedBy: { name: string | null; email: string; avatarUrl: string | null } | null;
  },
  now = new Date(),
): InviteView {
  return {
    ...invite,
    status: inviteStatus(invite, now),
    createdBy: invite.createdBy.name ?? invite.createdBy.email,
  };
}

/** Newest first; capped so the page stays bounded. */
export async function getInvites(): Promise<InviteView[]> {
  const invites = await prisma.invite.findMany({ select: inviteSelect, orderBy: { createdAt: "desc" }, take: 100 });
  const now = new Date();
  return invites.map((invite) => toInviteView(invite, now));
}

export async function getMemberCount(): Promise<number> {
  return prisma.user.count();
}
