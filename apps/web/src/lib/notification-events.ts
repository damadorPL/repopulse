import { z } from "zod";

/**
 * What a notification rule fires for (Slice 08). Mirrors the Prisma `NotificationEvent` enum; `lib/`
 * can't import `@repopulse/db`, so the values are repeated here. `toNotificationRuleView` passes Prisma values
 * through `normalizeEvents` and back, so the build fails when the two lists diverge.
 */
export const NOTIFICATION_EVENTS = ["RELEASES", "DEPENDENCY_UPDATES", "DEPENDENCY_PULL_REQUESTS"] as const;
export type NotificationEventValue = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEventValue, string> = {
  RELEASES: "Releases",
  DEPENDENCY_UPDATES: "Dependency updates",
  DEPENDENCY_PULL_REQUESTS: "Dependency pull requests",
};

export const NOTIFICATION_EVENT_HINTS: Record<NotificationEventValue, string> = {
  RELEASES: "New releases, tags and file changes of the repositories you track.",
  DEPENDENCY_UPDATES: "A digest of outdated dependencies after a check of one of your projects.",
  DEPENDENCY_PULL_REQUESTS: "Update pull requests opened, updated or edited by someone else.",
};

/** Events a tag-scoped rule can have: projects have no tags, so only releases. */
export const TAG_SCOPED_EVENTS: readonly NotificationEventValue[] = ["RELEASES"];

export const DEFAULT_NOTIFICATION_EVENTS: NotificationEventValue[] = ["RELEASES"];

/** Whether an event can be chosen for a rule with (or without) a tag scope. */
export function isEventAllowedForScope(event: NotificationEventValue, tagScoped: boolean): boolean {
  return !tagScoped || TAG_SCOPED_EVENTS.includes(event);
}

/** Sorted, de-duplicated list in {@link NOTIFICATION_EVENTS} order. */
export function normalizeEvents(events: readonly NotificationEventValue[]): NotificationEventValue[] {
  return NOTIFICATION_EVENTS.filter((event) => events.includes(event));
}

export const notificationEventsSchema = z
  .array(z.enum(NOTIFICATION_EVENTS, "Unknown notification event"), "Choose at least one event")
  .min(1, "Choose at least one event")
  .max(NOTIFICATION_EVENTS.length, "Too many events")
  .transform(normalizeEvents);

/** The message shown when a tag-scoped rule asks for dependency events. */
export const TAG_SCOPED_EVENTS_MESSAGE = "A rule limited to a tag can only notify about releases. Dependency projects have no tags.";

/** Checks the tag-scope restriction; returns an error message or null. */
export function validateEventsForScope(events: readonly NotificationEventValue[], tagScoped: boolean): string | null {
  return events.every((event) => isEventAllowedForScope(event, tagScoped)) ? null : TAG_SCOPED_EVENTS_MESSAGE;
}
