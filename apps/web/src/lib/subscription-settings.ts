import { z } from "zod";

/**
 * Per-subscription settings edited on the repository settings page (Slice 07): include
 * pre-releases, pin, note, notification level, snooze and "my version". Shared by the Server
 * Action (validation) and the client forms (labels, limits), so this module stays browser-safe.
 */

/** Mirrors the Prisma `NotificationLevel` enum (kept local so client bundles never import @repopulse/db). */
export const NOTIFICATION_LEVELS = ["ALL", "MINOR_AND_UP", "MAJOR_ONLY", "NONE"] as const;
export type NotificationLevelValue = (typeof NOTIFICATION_LEVELS)[number];

export const NOTIFICATION_LEVEL_OPTIONS: ReadonlyArray<{ value: NotificationLevelValue; label: string; hint: string }> = [
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

/**
 * A version as the user types it: loosely a Git tag name (no spaces, control characters or
 * `~ ^ : ? * [ \`), at most {@link CURRENT_VERSION_MAX_LENGTH} characters. Empty clears it.
 */
// eslint-disable-next-line no-control-regex -- Git tag names cannot contain control characters.
const VERSION_TEXT_RE = /^[^\s~^:?*[\\\u0000-\u001f\u007f]+$/;

const currentVersionSchema = z
  .string()
  .trim()
  .max(CURRENT_VERSION_MAX_LENGTH, `Versions can be at most ${CURRENT_VERSION_MAX_LENGTH} characters.`)
  .refine((value) => value === "" || (VERSION_TEXT_RE.test(value) && !value.includes("..")), {
    message: "Enter a version as it appears in the tag name, like v2.4.1.",
  })
  .transform((value) => (value === "" ? null : value));

const noteSchema = z
  .string()
  .max(NOTE_MAX_LENGTH, `Notes can be at most ${NOTE_MAX_LENGTH} characters.`)
  .transform((value) => (value.trim() === "" ? null : value.replace(/\r\n/g, "\n").trimEnd()));

const snoozedUntilSchema = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Choose a valid date." })
  .transform((value) => new Date(value));

/** Input of `updateSubscriptionSettingsAction`: every field optional, at least one present. */
export const subscriptionSettingsInput = z
  .object({
    subscriptionId: z.string().min(1).max(64),
    includePrereleases: z.boolean().optional(),
    isPinned: z.boolean().optional(),
    note: z.union([noteSchema, z.null()]).optional(),
    notificationLevel: z.enum(NOTIFICATION_LEVELS).optional(),
    /** ISO timestamp, or `null` to end the snooze. */
    snoozedUntil: z.union([snoozedUntilSchema, z.null()]).optional(),
    currentVersion: z.union([currentVersionSchema, z.null()]).optional(),
  })
  .strict()
  .refine((value) => Object.entries(value).some(([key, field]) => key !== "subscriptionId" && field !== undefined), {
    message: "Nothing to update.",
  });

export type SubscriptionSettingsInput = z.input<typeof subscriptionSettingsInput>;

/** Rejects a snooze that already ended or lies too far ahead. Returns a message, or `null` when fine. */
export function validateSnooze(until: Date, now: Date = new Date()): string | null {
  if (until.getTime() <= now.getTime()) return "Choose a time in the future.";
  if (until.getTime() > snoozeUntil(MAX_SNOOZE_DAYS, now).getTime()) return "Snooze for at most a year.";
  return null;
}
