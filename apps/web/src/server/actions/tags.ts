"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@repopulse/db";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { HEX_COLOR_RE, TAG_NAME_MAX_LENGTH, tagSlug } from "@/lib/tags";
import { fail, invalidInput, isUniqueConstraintError, ok, toActionError, type ActionResult } from "@/server/action-result";
import type { TagPill } from "@/server/queries/feed";

const id = z.string().min(1).max(64);
const tagName = z
  .string()
  .trim()
  .min(1, "Enter a tag name")
  .max(TAG_NAME_MAX_LENGTH, `Tag names can be at most ${TAG_NAME_MAX_LENGTH} characters`);
const colorHex = z.string().regex(HEX_COLOR_RE, "Color must be a hex value like #EF4444");

const createTagInput = z.object({ name: tagName, colorHex });
const updateTagInput = z
  .object({ tagId: id, name: tagName.optional(), colorHex: colorHex.optional() })
  .refine((v) => v.name !== undefined || v.colorHex !== undefined, "Nothing to update");
const deleteTagInput = z.object({ tagId: id });
const assignTagsInput = z.object({ subscriptionId: id, tagIds: z.array(id).max(50) });

const tagSelect = { id: true, name: true, slug: true, colorHex: true } as const;

function duplicate(name: string): ActionResult<never> {
  return fail("CONFLICT", `You already have a tag named "${name}".`);
}

function revalidateDashboard(): void {
  revalidatePath("/", "layout");
}

export async function createTagAction(input: { name: string; colorHex: string }): Promise<ActionResult<TagPill>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = createTagInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);

    const slug = tagSlug(parsed.data.name);
    const tag = await prisma.tag.create({
      data: { userId: user.id, name: parsed.data.name, slug, colorHex: parsed.data.colorHex.toUpperCase() },
      select: tagSelect,
    });
    revalidateDashboard();
    return ok(tag);
  } catch (error) {
    if (isUniqueConstraintError(error)) return duplicate(input.name.trim());
    return toActionError(error, "createTagAction");
  }
}

/** Rename and/or recolor. Renaming re-derives the slug, so `?tag=` links to the old slug stop matching. */
export async function updateTagAction(input: {
  tagId: string;
  name?: string;
  colorHex?: string;
}): Promise<ActionResult<TagPill>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = updateTagInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { tagId, name, colorHex: color } = parsed.data;

    const slug = name !== undefined ? tagSlug(name) : undefined;

    // updateMany scoped by userId: a single ownership-checked statement.
    const { count } = await prisma.tag.updateMany({
      where: { id: tagId, userId: user.id },
      data: { ...(name !== undefined ? { name, slug } : {}), ...(color ? { colorHex: color.toUpperCase() } : {}) },
    });
    if (count === 0) return fail("NOT_FOUND", "Tag not found.");

    const tag = await prisma.tag.findUniqueOrThrow({ where: { id: tagId }, select: tagSelect });
    revalidateDashboard();
    return ok(tag);
  } catch (error) {
    if (isUniqueConstraintError(error)) return duplicate(input.name?.trim() ?? "");
    return toActionError(error, "updateTagAction");
  }
}

/** Deletes the tag; its `SubscriptionTag` links cascade and notification rules fall back to `tagId = null`. */
export async function deleteTagAction(input: { tagId: string }): Promise<ActionResult<{ tagId: string }>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = deleteTagInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);

    const { count } = await prisma.tag.deleteMany({ where: { id: parsed.data.tagId, userId: user.id } });
    if (count === 0) return fail("NOT_FOUND", "Tag not found.");

    revalidateDashboard();
    return ok({ tagId: parsed.data.tagId });
  } catch (error) {
    return toActionError(error, "deleteTagAction");
  }
}

/** Replaces the tag set of one of the user's subscriptions. */
export async function assignTagsAction(input: {
  subscriptionId: string;
  tagIds: string[];
}): Promise<ActionResult<{ subscriptionId: string; tags: TagPill[] }>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = assignTagsInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { subscriptionId } = parsed.data;
    const tagIds = [...new Set(parsed.data.tagIds)];

    const result = await prisma.$transaction(async (tx) => {
      const subscription = await tx.userSubscription.findFirst({
        where: { id: subscriptionId, userId: user.id },
        select: { id: true },
      });
      if (!subscription) return fail("NOT_FOUND", "Subscription not found.");

      const tags = await tx.tag.findMany({ where: { id: { in: tagIds }, userId: user.id }, select: tagSelect });
      if (tags.length !== tagIds.length) {
        return fail("NOT_FOUND", "One or more tags no longer exist. Refresh and try again.");
      }

      await tx.subscriptionTag.deleteMany({ where: { subscriptionId } });
      if (tags.length > 0) {
        // skipDuplicates: two concurrent saves must not fail on the composite primary key.
        await tx.subscriptionTag.createMany({
          data: tags.map((tag) => ({ subscriptionId, tagId: tag.id })),
          skipDuplicates: true,
        });
      }
      return ok({ subscriptionId, tags: tags.sort((a, b) => a.name.localeCompare(b.name)) });
    });

    if (result.ok) revalidateDashboard();
    return result;
  } catch (error) {
    return toActionError(error, "assignTagsAction");
  }
}
