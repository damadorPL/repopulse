"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma, type User as DbUser } from "@repopulse/db";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { INVITE_EXPIRY_DAYS, INVITE_NOTE_MAX_LENGTH, MAX_PENDING_INVITES } from "@/lib/invites";
import { generateInviteToken, hashInviteToken } from "@/server/invite-tokens";
import { fail, invalidInput, ok, toActionError, type ActionResult } from "@/server/action-result";
import { inviteSelect, toInviteView, type InviteView } from "@/server/queries/access";

const DAY_MS = 24 * 60 * 60 * 1000;

const setRegistrationInput = z.object({ enabled: z.boolean() });
const createInviteInput = z.object({
  note: z
    .string()
    .trim()
    .max(INVITE_NOTE_MAX_LENGTH, `Notes can be at most ${INVITE_NOTE_MAX_LENGTH} characters`)
    .optional()
    .transform((v) => v || null),
  expiresInDays: z
    .number()
    .refine((d) => (INVITE_EXPIRY_DAYS as readonly number[]).includes(d), `Choose ${INVITE_EXPIRY_DAYS.join(", ")} days`),
});
const deleteInviteInput = z.object({ inviteId: z.string().min(1).max(64) });

class ForbiddenError extends Error {}

async function getAdminOrThrow(): Promise<DbUser> {
  const user = await getCurrentUserOrThrow();
  if (!user.isAdmin) throw new ForbiddenError();
  return user;
}

function handle(error: unknown, action: string): ActionResult<never> {
  if (error instanceof ForbiddenError) return fail("FORBIDDEN", "Only admins can manage access.");
  return toActionError(error, action);
}

function revalidateAccess(): void {
  revalidatePath("/settings/access");
}

export async function setPublicRegistrationAction(input: { enabled: boolean }): Promise<ActionResult<{ enabled: boolean }>> {
  try {
    await getAdminOrThrow();
    const parsed = setRegistrationInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);

    const { publicRegistration } = await prisma.instanceSettings.upsert({
      where: { id: 1 },
      create: { id: 1, publicRegistration: parsed.data.enabled },
      update: { publicRegistration: parsed.data.enabled },
      select: { publicRegistration: true },
    });
    revalidateAccess();
    return ok({ enabled: publicRegistration });
  } catch (error) {
    return handle(error, "setPublicRegistrationAction");
  }
}

/** Returns the raw token once; only its hash is stored, so the link can't be shown again. */
export async function createInviteAction(input: {
  note?: string;
  expiresInDays: number;
}): Promise<ActionResult<{ invite: InviteView; token: string }>> {
  try {
    const admin = await getAdminOrThrow();
    const parsed = createInviteInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);

    const now = new Date();
    const pending = await prisma.invite.count({ where: { usedAt: null, expiresAt: { gt: now } } });
    if (pending >= MAX_PENDING_INVITES) {
      return fail("CONFLICT", `You already have ${MAX_PENDING_INVITES} open invite links. Revoke some first.`);
    }

    const token = generateInviteToken();
    const invite = await prisma.invite.create({
      data: {
        tokenHash: hashInviteToken(token),
        note: parsed.data.note,
        createdById: admin.id,
        expiresAt: new Date(now.getTime() + parsed.data.expiresInDays * DAY_MS),
      },
      select: inviteSelect,
    });
    revalidateAccess();
    return ok({ invite: toInviteView(invite, now), token });
  } catch (error) {
    return handle(error, "createInviteAction");
  }
}

/** Revokes a pending link, or clears a used / expired one from the list. Accounts are never touched. */
export async function deleteInviteAction(input: { inviteId: string }): Promise<ActionResult<null>> {
  try {
    await getAdminOrThrow();
    const parsed = deleteInviteInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);

    const { count } = await prisma.invite.deleteMany({ where: { id: parsed.data.inviteId } });
    if (count === 0) return fail("NOT_FOUND", "Invite not found.");
    revalidateAccess();
    return ok(null);
  } catch (error) {
    return handle(error, "deleteInviteAction");
  }
}
