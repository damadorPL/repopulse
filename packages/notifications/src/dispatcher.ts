import { CHANNEL_INFO, channelLabel, isDeliverableChannel, maskDestination } from "./channels.js";
import { NotificationDeliveryError } from "./errors.js";
import { formatCustomWebhookPayload } from "./formatters/custom.js";
import { formatDiscordPayload } from "./formatters/discord.js";
import { createSmtpSender, readSmtpConfig, renderReleaseEmail, type MailSender } from "./formatters/email.js";
import { buildGotifyRequest, buildNtfyRequest, type PreparedRequest } from "./formatters/ntfy-gotify.js";
import { formatSlackPayload } from "./formatters/slack.js";
import { DEFAULT_TIMEOUT_MS, postWebhook, type WebhookSender } from "./http.js";
import { internalHostsPolicyFromEnv, type InternalHostsPolicy, type ResolveAll } from "./ssrf-guard.js";
import type { DispatchInput, MessageContext } from "./types.js";

export interface DispatchOptions {
  /** Defaults to `process.env` (SMTP_*, ALLOW_INTERNAL_WEBHOOK_HOSTS, APP_BASE_URL). */
  env?: Record<string, string | undefined>;
  /** Overrides `APP_BASE_URL`/`AUTH_URL` for links back to RepoPulse. */
  appBaseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injected transports (tests). */
  sendWebhook?: WebhookSender;
  sendMail?: MailSender;
  resolveAll?: ResolveAll;
  policy?: InternalHostsPolicy;
}

export interface DispatchResult {
  channel: string;
  /** Masked destination, safe to log and display. */
  destination: string;
  /** HTTP status of webhook deliveries. */
  status?: number;
}

/**
 * Public URL of the web app: `APP_BASE_URL`, else Auth.js' `AUTH_URL`/`NEXTAUTH_URL`. A bare
 * domain (Coolify's `SERVICE_FQDN_*` may come without a scheme) gets `https://`.
 */
export function resolveAppBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.APP_BASE_URL || env.AUTH_URL || env.NEXTAUTH_URL || "http://localhost:3000").trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/** The feed with the release's changelog drawer open (`?release=` is read by the dashboard). */
export function releaseReaderUrl(appBaseUrl: string, releaseId: string): string {
  return `${appBaseUrl}/?release=${encodeURIComponent(releaseId)}`;
}

function jsonRequest(url: string, payload: unknown): PreparedRequest {
  return { url: new URL(url), headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
}

/**
 * Formats and delivers one notification for `rule` over its channel. Resolves when the service
 * accepted it; throws `NotificationDeliveryError` (with `permanent`) otherwise.
 *
 * Rule filters (`enabled`, `onlyMajorReleases`, tag scope) are the caller's job: the worker
 * applies them, "Send Test" deliberately skips them.
 */
export async function dispatchNotification(input: DispatchInput, options: DispatchOptions = {}): Promise<DispatchResult> {
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
  const ctx: MessageContext = {
    ...input,
    appBaseUrl,
    readerUrl: input.readerUrl ?? releaseReaderUrl(appBaseUrl, input.release.id),
  };

  if (channel === "EMAIL_INSTANT") {
    const to = rule.destinationUrl?.trim() || input.user.email;
    let sendMail = options.sendMail;
    const config = readSmtpConfig(env);
    if (!sendMail) {
      if (!config) {
        throw new NotificationDeliveryError("Email is not configured on this server (SMTP_HOST is not set).", { permanent: true });
      }
      sendMail = createSmtpSender(config);
    }
    const email = renderReleaseEmail(ctx);
    await sendMail({ from: config?.from ?? "RepoPulse <repopulse@localhost>", to, ...email });
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
        request = jsonRequest(url, formatDiscordPayload(ctx));
        break;
      case "SLACK_WEBHOOK":
        request = jsonRequest(url, formatSlackPayload(ctx));
        break;
      case "NTFY_WEBHOOK":
        request = buildNtfyRequest(ctx, url);
        break;
      case "GOTIFY_WEBHOOK":
        request = buildGotifyRequest(ctx, url);
        break;
      case "CUSTOM_WEBHOOK":
        request = jsonRequest(url, formatCustomWebhookPayload(ctx));
        request.headers["X-RepoPulse-Event"] = ctx.test ? "test" : "release.published";
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

/** The synthetic release used by "Send Test". */
export function buildTestRelease(now = new Date()) {
  return {
    release: {
      id: "repopulse-test-release",
      tagName: "v1.0.0",
      title: "v1.0.0 - RepoPulse Test Release",
      bodyMarkdown: [
        "## What's new",
        "",
        "- Your notification rule works: this is how new releases will look.",
        "- Changelogs are summarized, with links to RepoPulse and GitHub.",
        "",
        "_This is a test notification. No repository actually released anything._",
      ].join("\n"),
      htmlUrl: "https://github.com",
      semverType: "MAJOR" as const,
      isPrerelease: false,
      publishedAt: now,
      source: "RELEASE" as const,
    },
    repository: { fullName: "repopulse/test-release", htmlUrl: "https://github.com", avatarUrl: null },
  };
}
