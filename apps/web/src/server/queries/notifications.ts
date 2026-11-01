import { prisma, type NotificationChannel } from "@repopulse/db";
import { maskDestination } from "@repopulse/notifications/channels";
import type { TagPill } from "@/server/queries/feed";

/** Most rules a user can have; keeps fan-out and the settings page bounded. */
export const MAX_NOTIFICATION_RULES = 25;

/** A rule as the settings page sees it. The destination is masked: webhook URLs carry secrets. */
export interface NotificationRuleView {
  id: string;
  channel: NotificationChannel;
  destination: string;
  tag: TagPill | null;
  onlyMajorReleases: boolean;
  enabled: boolean;
  createdAt: Date;
}

export const notificationRuleSelect = {
  id: true,
  channel: true,
  destinationUrl: true,
  onlyMajorReleases: true,
  enabled: true,
  createdAt: true,
  tag: { select: { id: true, name: true, slug: true, colorHex: true } },
} as const;

export function toNotificationRuleView(rule: {
  id: string;
  channel: NotificationChannel;
  destinationUrl: string | null;
  onlyMajorReleases: boolean;
  enabled: boolean;
  createdAt: Date;
  tag: TagPill | null;
}): NotificationRuleView {
  const { destinationUrl, ...rest } = rule;
  return { ...rest, destination: maskDestination(rule.channel, destinationUrl) };
}

export async function getNotificationRules(userId: string): Promise<NotificationRuleView[]> {
  const rules = await prisma.notificationRule.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: notificationRuleSelect,
  });
  return rules.map(toNotificationRuleView);
}
