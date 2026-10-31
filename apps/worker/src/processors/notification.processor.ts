import type { Job } from "bullmq";
import type { PrismaClient } from "@repopulse/db";
import type { NotificationJobData } from "@repopulse/queue";
import { createLogger } from "../logger";

const log = createLogger("notification-dispatch");

export type NotificationOutcome = { status: "SKIPPED"; reason: "RULE_GONE" | "RULE_DISABLED" } | { status: "DEFERRED" };

/**
 * `notification-dispatch` job. Slice 04 only hands jobs off; Slice 05 replaces the body with the
 * `@repopulse/notifications` formatters and senders (email, Slack, Discord, ntfy, Gotify, webhooks).
 */
export async function processNotification(
  job: Job<NotificationJobData>,
  deps: { prisma: PrismaClient },
): Promise<NotificationOutcome> {
  const { ruleId, releaseId, userId } = job.data;
  const rule = await deps.prisma.notificationRule.findUnique({
    where: { id: ruleId },
    select: { userId: true, channel: true, enabled: true },
  });
  if (!rule || rule.userId !== userId) return { status: "SKIPPED", reason: "RULE_GONE" };
  if (!rule.enabled) return { status: "SKIPPED", reason: "RULE_DISABLED" };

  log.info(`rule ${ruleId} (${rule.channel}) matched release ${releaseId} for user ${userId}; delivery ships in Slice 05`);
  return { status: "DEFERRED" };
}
