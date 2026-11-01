"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@repopulse/db";
import {
  buildTestRelease,
  dispatchNotification,
  isDeliverableChannel,
  isNotificationDeliveryError,
  resolveAppBaseUrl,
} from "@repopulse/notifications";
import { CHANNEL_INFO, DELIVERABLE_CHANNELS } from "@repopulse/notifications/channels";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { fail, invalidInput, ok, toActionError, type ActionResult } from "@/server/action-result";
import { normalizeDestination } from "@/server/notification-destination";
import {
  MAX_NOTIFICATION_RULES,
  notificationRuleSelect,
  toNotificationRuleView,
  type NotificationRuleView,
} from "@/server/queries/notifications";

const SETTINGS_PATH = "/settings/notifications";
/** "Send Test" cooldown per rule, so the button can't be used to flood a channel or an inbox. */
const TEST_COOLDOWN_MS = 10_000;

const id = z.string().min(1).max(64);
const createInput = z.object({
  tagId: id.nullable(),
  channel: z.enum(DELIVERABLE_CHANNELS, "Choose a channel"),
  destinationUrl: z.string().max(2048, "The destination can be at most 2048 characters").default(""),
  onlyMajorReleases: z.boolean(),
});
const toggleInput = z.object({ ruleId: id, enabled: z.boolean() });
const ruleInput = z.object({ ruleId: id });

const lastTestAt = new Map<string, number>();

export async function createNotificationRuleAction(input: {
  tagId: string | null;
  channel: string;
  destinationUrl: string;
  onlyMajorReleases: boolean;
}): Promise<ActionResult<NotificationRuleView>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = createInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { tagId, channel, onlyMajorReleases } = parsed.data;

    const count = await prisma.notificationRule.count({ where: { userId: user.id } });
    if (count >= MAX_NOTIFICATION_RULES) {
      return fail("CONFLICT", `You can have at most ${MAX_NOTIFICATION_RULES} notification rules. Delete one first.`);
    }
    if (tagId) {
      const tag = await prisma.tag.findFirst({ where: { id: tagId, userId: user.id }, select: { id: true } });
      if (!tag) return fail("NOT_FOUND", "That tag no longer exists. Refresh and try again.");
    }

    const destination = await normalizeDestination(channel, parsed.data.destinationUrl);
    if (!destination.ok) return destination;

    const rule = await prisma.notificationRule.create({
      data: { userId: user.id, tagId, channel, destinationUrl: destination.data, onlyMajorReleases, enabled: true },
      select: notificationRuleSelect,
    });
    revalidatePath(SETTINGS_PATH);
    return ok(toNotificationRuleView(rule));
  } catch (error) {
    return toActionError(error, "createNotificationRuleAction");
  }
}

export async function toggleNotificationRuleAction(input: {
  ruleId: string;
  enabled: boolean;
}): Promise<ActionResult<{ ruleId: string; enabled: boolean }>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = toggleInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { ruleId, enabled } = parsed.data;

    const { count } = await prisma.notificationRule.updateMany({ where: { id: ruleId, userId: user.id }, data: { enabled } });
    if (count === 0) return fail("NOT_FOUND", "Notification rule not found.");
    revalidatePath(SETTINGS_PATH);
    return ok({ ruleId, enabled });
  } catch (error) {
    return toActionError(error, "toggleNotificationRuleAction");
  }
}

/** Already queued jobs of a deleted rule are skipped by the worker (`RULE_GONE`). */
export async function deleteNotificationRuleAction(input: { ruleId: string }): Promise<ActionResult<{ ruleId: string }>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = ruleInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);

    const { count } = await prisma.notificationRule.deleteMany({ where: { id: parsed.data.ruleId, userId: user.id } });
    if (count === 0) return fail("NOT_FOUND", "Notification rule not found.");
    lastTestAt.delete(parsed.data.ruleId);
    revalidatePath(SETTINGS_PATH);
    return ok({ ruleId: parsed.data.ruleId });
  } catch (error) {
    return toActionError(error, "deleteNotificationRuleAction");
  }
}

/**
 * Delivers a synthetic `v1.0.0 - RepoPulse Test Release` through the rule's channel right away
 * (not via the queue), so the result can be shown in the UI. Works for disabled rules too, and
 * ignores the rule's filters (tag scope, major-only).
 */
export async function sendTestNotificationAction(input: {
  ruleId: string;
}): Promise<ActionResult<{ channel: string; destination: string }>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = ruleInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { ruleId } = parsed.data;

    const rule = await prisma.notificationRule.findFirst({
      where: { id: ruleId, userId: user.id },
      select: { id: true, channel: true, destinationUrl: true, onlyMajorReleases: true, tag: { select: { name: true, colorHex: true } } },
    });
    if (!rule) return fail("NOT_FOUND", "Notification rule not found.");
    if (!isDeliverableChannel(rule.channel)) return fail("INVALID_INPUT", "This rule's channel cannot be tested.");

    const now = Date.now();
    const last = lastTestAt.get(ruleId);
    if (last !== undefined && now - last < TEST_COOLDOWN_MS) {
      const seconds = Math.ceil((TEST_COOLDOWN_MS - (now - last)) / 1000);
      return fail("RATE_LIMITED", `Wait ${seconds} s before sending another test.`);
    }
    lastTestAt.set(ruleId, now);

    const { release, repository } = buildTestRelease(new Date(now));
    try {
      const result = await dispatchNotification({
        rule,
        release,
        repository,
        user: { id: user.id, email: user.email, name: user.name },
        test: true,
        readerUrl: `${resolveAppBaseUrl()}${SETTINGS_PATH}`,
      });
      return ok({ channel: CHANNEL_INFO[rule.channel].label, destination: result.destination });
    } catch (error) {
      if (isNotificationDeliveryError(error)) return fail("DELIVERY_FAILED", error.message);
      throw error;
    }
  } catch (error) {
    return toActionError(error, "sendTestNotificationAction");
  }
}
