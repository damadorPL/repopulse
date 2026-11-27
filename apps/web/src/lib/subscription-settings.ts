/**
 * Per-subscription settings edited on the repository settings page (Slice 07): include
 * pre-releases, pin, note, notification level, snooze and "my version". Shared by the Server
 * Action and the client forms (labels, limits, types), so this module stays browser-safe (no Zod).
 * Server Action validation schema lives in `./subscription-settings-schema`.
 */

/** Mirrors the Prisma `NotificationLevel` enum (kept local so client bundles never import @repopulse/db). */
export const NOTIFICATION_LEVELS = ["ALL", "MINOR_AND_UP", "MAJOR_ONLY", "NONE"] as const;
export type NotificationLevelValue = (typeof NOTIFICATION_LEVELS)[number];

export const NOTIFICATION_LEVEL_OPTIONS: ReadonlyArray<{ value: NotificationLevelValue; label: string; hint: string }> =
  [
    { value: "ALL", label: "All updates", hint: "Your notification rules decide." },
    {
      value: "MINOR_AND_UP",
      label: "Minor and major",
      hint: "Skips patch releases, pre-releases and commits.",
    },
    { value: "MAJOR_ONLY", label: "Major releases only", hint: "Skips everything else, commits included." },
    { value: "NONE", label: "Feed only", hint: "No external notifications. The feed and unread count still update." },
  ];

export function isNotificationLevel(value: string): value is NotificationLevelValue {
  return (NOTIFICATION_LEVELS as readonly string[]).includes(value);
}

export const NOTE_MAX_LENGTH = 2000;
export const CURRENT_VERSION_MAX_LENGTH = 100;
/** A snooze can't be set further out than this. */
export const MAX_SNOOZE_DAYS = 366;

export const SNOOZE_PRESETS = [
  { key: "1d", label: "1 day", days: 1 },
  { key: "1w", label: "1 week", days: 7 },
  { key: "1m", label: "1 month", days: 30 },
] as const;

/** Snooze end for a preset, from `now`. */
export function snoozeUntil(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Input of `updateSubscriptionSettingsAction`: every field optional, at least one present. */
export interface SubscriptionSettingsInput {
  subscriptionId: string;
  includePrereleases?: boolean;
  isPinned?: boolean;
  note?: string | null;
  notificationLevel?: NotificationLevelValue;
  /** ISO timestamp, or `null` to end the snooze. */
  snoozedUntil?: string | null;
  currentVersion?: string | null;
}

/** Rejects a snooze that already ended or lies too far ahead. Returns a message, or `null` when fine. */
export function validateSnooze(until: Date, now: Date = new Date()): string | null {
  if (until.getTime() <= now.getTime()) return "Choose a time in the future.";
  if (until.getTime() > snoozeUntil(MAX_SNOOZE_DAYS, now).getTime()) return "Snooze for at most a year.";
  return null;
}
