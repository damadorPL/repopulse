import { z } from "zod";
import { CURRENT_VERSION_MAX_LENGTH, NOTE_MAX_LENGTH, NOTIFICATION_LEVELS } from "./subscription-settings";

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
  .refine(
    (value) => value === "" || (VERSION_TEXT_RE.test(value) && !value.includes("..")),
    "Enter a version as it appears in the tag name, like v2.4.1.",
  )
  .transform((value) => (value === "" ? null : value));

const noteSchema = z
  .string()
  .max(NOTE_MAX_LENGTH, `Notes can be at most ${NOTE_MAX_LENGTH} characters.`)
  .transform((value) => (value.trim() === "" ? null : value.replace(/\r\n/g, "\n").trimEnd()));

const snoozedUntilSchema = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Choose a valid date.")
  .transform((value) => new Date(value));

/** Input of `updateSubscriptionSettingsAction`: every field optional, at least one present. */
export const subscriptionSettingsInput = z
  .strictObject({
    subscriptionId: z.string().min(1).max(64),
    includePrereleases: z.boolean().optional(),
    isPinned: z.boolean().optional(),
    note: noteSchema.nullish(),
    notificationLevel: z.enum(NOTIFICATION_LEVELS).optional(),
    /** ISO timestamp, or `null` to end the snooze. */
    snoozedUntil: snoozedUntilSchema.nullish(),
    currentVersion: currentVersionSchema.nullish(),
  })
  .refine(
    (value) => Object.entries(value).some(([key, field]) => key !== "subscriptionId" && field !== undefined),
    "Nothing to update.",
  );

export type SubscriptionSettingsInput = z.input<typeof subscriptionSettingsInput>;
