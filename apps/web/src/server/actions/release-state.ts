"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@repopulse/db";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { MAX_SEARCH_LENGTH, SEMVER_TYPES } from "@/lib/feed-filters";
import { fail, invalidInput, ok, toActionError, type ActionResult } from "@/server/action-result";
import { buildFeedWhere, visibleReleasesWhere } from "@/server/queries/feed";

const id = z.string().min(1).max(64);

const toggleInput = z.object({ releaseId: id, isRead: z.boolean() });

const markAllInput = z.object({
  tagSlug: id.optional(),
  repositoryId: id.optional(),
  semverType: z.enum(SEMVER_TYPES).optional(),
  searchQuery: z.string().trim().max(MAX_SEARCH_LENGTH).optional(),
});

/** Marks one release read/unread for the current user. */
export async function toggleReleaseReadAction(input: {
  releaseId: string;
  isRead: boolean;
}): Promise<ActionResult<{ releaseId: string; isRead: boolean }>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = toggleInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { releaseId, isRead } = parsed.data;

    // Only releases from the user's own subscriptions can get a state row.
    const release = await prisma.release.findFirst({
      where: { AND: [{ id: releaseId }, visibleReleasesWhere(user.id)] },
      select: { id: true },
    });
    if (!release) return fail("NOT_FOUND", "Release not found.");

    const readAt = isRead ? new Date() : null;
    await prisma.userReleaseState.upsert({
      where: { userId_releaseId: { userId: user.id, releaseId } },
      create: { userId: user.id, releaseId, isRead, readAt },
      update: { isRead, readAt },
    });

    revalidatePath("/", "layout");
    return ok({ releaseId, isRead });
  } catch (error) {
    return toActionError(error, "toggleReleaseReadAction");
  }
}

/**
 * Marks every unread release matching the given feed filter as read (no filter = everything).
 * Releases without a state row already count as read, so updating existing rows is enough.
 */
export async function markAllReadAction(
  input: {
    tagSlug?: string;
    repositoryId?: string;
    semverType?: (typeof SEMVER_TYPES)[number];
    searchQuery?: string;
  } = {},
): Promise<ActionResult<{ count: number }>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = markAllInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);

    const { count } = await prisma.userReleaseState.updateMany({
      where: { userId: user.id, isRead: false, release: buildFeedWhere(user.id, parsed.data) },
      data: { isRead: true, readAt: new Date() },
    });

    revalidatePath("/", "layout");
    return ok({ count });
  } catch (error) {
    return toActionError(error, "markAllReadAction");
  }
}
