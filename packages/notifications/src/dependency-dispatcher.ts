import { CHANNEL_INFO, channelLabel, isDeliverableChannel, maskDestination } from "./channels.js";
import { resolveAppBaseUrl, SMTP_NOT_CONFIGURED_MESSAGE, type DispatchOptions, type DispatchResult } from "./dispatcher.js";
import { NotificationDeliveryError } from "./errors.js";
import {
  buildDependencyContext,
  buildDependencyGotifyRequest,
  buildDependencyNtfyRequest,
  formatDependencyDiscordPayload,
  formatDependencySlackPayload,
  formatDependencyWebhookPayload,
  renderDependencyEmail,
  type DependencyNotificationInput,
} from "./formatters/dependencies.js";
import { createSmtpSender } from "./formatters/email.js";
import type { PreparedRequest } from "./formatters/ntfy-gotify.js";
import { DEFAULT_TIMEOUT_MS, postWebhook } from "./http.js";
import { internalHostsPolicyFromEnv } from "./ssrf-guard.js";

function jsonRequest(url: string, payload: unknown): PreparedRequest {
  return { url: new URL(url), headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

/**
 * Formats and delivers one dependency notification (an outdated digest or a pull request event)
 * over `rule`'s channel. Same options, transports, SSRF guard and error classification as
 * `dispatchNotification`: resolves when the service accepted it, throws `NotificationDeliveryError`
 * (with `permanent`) otherwise.
 *
 * `IN_APP` and `EMAIL_DIGEST` rules are rejected with a permanent error, exactly like release
 * notifications: in-app is the project page + SSE event, and email digests have no sender yet. The
 * caller should not queue jobs for them (check `isDeliverableChannel`), or mark such jobs `SKIPPED`.
 *
 * Rule filters (enabled, events, level) are the caller's job.
 */
export async function dispatchDependencyNotification(
  input: DependencyNotificationInput,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const env = options.env ?? process.env;
  const { rule } = input;
  const channel = rule.channel;
  if (!isDeliverableChannel(channel)) {
    throw new NotificationDeliveryError(`${channelLabel(channel)} rules are not delivered by the notification dispatcher.`, {
      permanent: true,
    });
  }
  const destination = maskDestination(channel, rule.destinationUrl);
  const appBaseUrl = (options.appBaseUrl ?? resolveAppBaseUrl(env)).replace(/\/+$/, "");
  const ctx = buildDependencyContext(input, appBaseUrl);

  if (channel === "EMAIL_INSTANT") {
    const to = rule.destinationUrl?.trim() || input.user?.email?.trim();
    if (!to) {
      throw new NotificationDeliveryError("This email rule has no recipient and the account has no email address.", { permanent: true });
    }
    const config = options.smtp ?? null;
    if (!config) throw new NotificationDeliveryError(SMTP_NOT_CONFIGURED_MESSAGE, { permanent: true });
    const sendMail = options.sendMail ?? createSmtpSender(config);
    await sendMail({ from: config.from, to, ...renderDependencyEmail(ctx) });
    return { channel, destination: to };
  }

  const url = rule.destinationUrl?.trim();
  if (!url) {
    throw new NotificationDeliveryError(`This ${CHANNEL_INFO[channel].label} rule has no ${CHANNEL_INFO[channel].destinationLabel}.`, {
      permanent: true,
    });
  }

  let request: PreparedRequest;
  try {
    switch (channel) {
      case "DISCORD_WEBHOOK":
        request = jsonRequest(url, formatDependencyDiscordPayload(ctx));
        break;
      case "SLACK_WEBHOOK":
        request = jsonRequest(url, formatDependencySlackPayload(ctx));
        break;
      case "NTFY_WEBHOOK":
        request = buildDependencyNtfyRequest(ctx, url);
        break;
      case "GOTIFY_WEBHOOK":
        request = buildDependencyGotifyRequest(ctx, url);
        break;
      case "CUSTOM_WEBHOOK":
        request = jsonRequest(url, formatDependencyWebhookPayload(ctx));
        request.headers["X-RepoPulse-Event"] = ctx.test ? "test" : ctx.event;
        break;
    }
  } catch (error) {
    if (error instanceof NotificationDeliveryError) throw error;
    throw new NotificationDeliveryError("The destination URL is not valid.", { permanent: true, cause: error });
  }

  const send = options.sendWebhook ?? postWebhook;
  const response = await send(
    { ...request, service: CHANNEL_INFO[channel].label, destination },
    {
      policy: options.policy ?? internalHostsPolicyFromEnv(env),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.resolveAll ? { resolveAll: options.resolveAll } : {}),
    },
  );
  return { channel, destination, status: response.status };
}
