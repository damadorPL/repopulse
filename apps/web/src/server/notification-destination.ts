import { z } from "zod";
import {
  resolveGotifyEndpoint,
  SMTP_NOT_CONFIGURED_MESSAGE,
  validateWebhookUrl,
  WebhookUrlError,
  type ValidateWebhookUrlOptions,
} from "@repopulse/notifications";
import { CHANNEL_INFO, type DeliverableChannel } from "@repopulse/notifications/channels";
import { fail, ok, type ActionResult } from "@/server/action-result";

/**
 * Checks and normalizes the destination of a new notification rule. Not a `"use server"` module,
 * so it can be unit-tested and is never callable from the browser.
 *
 * - Webhook channels need an http(s) URL whose host resolves to a public address (SSRF guard,
 *   honoring `ALLOW_INTERNAL_WEBHOOK_HOSTS`). The worker checks again on every delivery.
 * - Email takes an optional recipient (empty = the account's email) and needs SMTP to be set up
 *   (Settings → Email; the caller passes `smtpConfigured`).
 */
export async function normalizeDestination(
  channel: DeliverableChannel,
  raw: string,
  options: ValidateWebhookUrlOptions & { smtpConfigured?: boolean } = {},
): Promise<ActionResult<string | null>> {
  const value = raw.trim();
  const info = CHANNEL_INFO[channel];

  if (info.destination === "email") {
    if (!options.smtpConfigured) return fail("UNAVAILABLE", SMTP_NOT_CONFIGURED_MESSAGE);
    if (!value) return ok(null);
    if (!z.email().safeParse(value).success) return fail("INVALID_INPUT", "Enter a valid email address, or leave it empty.");
    return ok(value);
  }

  if (!value) return fail("INVALID_INPUT", `Enter the ${info.label} ${info.destinationLabel.toLowerCase()}.`);
  try {
    const url = await validateWebhookUrl(value, options);
    if (channel === "GOTIFY_WEBHOOK") resolveGotifyEndpoint(url.href);
    return ok(url.href);
  } catch (error) {
    if (error instanceof WebhookUrlError) return fail("INVALID_INPUT", error.message);
    throw error;
  }
}
