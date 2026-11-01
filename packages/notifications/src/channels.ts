/**
 * Channel metadata shared by the settings UI and the server. Browser-safe (no Node imports):
 * exported separately as `@repopulse/notifications/channels`.
 */

/** Channels a rule can be created for. `IN_APP` is always on (unread state + SSE); digests are not built yet. */
export const DELIVERABLE_CHANNELS = [
  "DISCORD_WEBHOOK",
  "SLACK_WEBHOOK",
  "NTFY_WEBHOOK",
  "GOTIFY_WEBHOOK",
  "EMAIL_INSTANT",
  "CUSTOM_WEBHOOK",
] as const;

export type DeliverableChannel = (typeof DELIVERABLE_CHANNELS)[number];

export interface ChannelInfo {
  label: string;
  /** `url`: destination is a webhook URL (required). `email`: optional recipient address. */
  destination: "url" | "email";
  destinationLabel: string;
  placeholder: string;
  hint: string;
}

export const CHANNEL_INFO: Record<DeliverableChannel, ChannelInfo> = {
  DISCORD_WEBHOOK: {
    label: "Discord",
    destination: "url",
    destinationLabel: "Webhook URL",
    placeholder: "https://discord.com/api/webhooks/123456789012345678/abcDEF…",
    hint: "Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.",
  },
  SLACK_WEBHOOK: {
    label: "Slack",
    destination: "url",
    destinationLabel: "Webhook URL",
    placeholder: "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
    hint: "Create an app with Incoming Webhooks enabled, then add a webhook for the channel. Slack-compatible webhooks (Mattermost) work too.",
  },
  NTFY_WEBHOOK: {
    label: "ntfy",
    destination: "url",
    destinationLabel: "Topic URL",
    placeholder: "https://ntfy.sh/my-repopulse-alerts",
    hint: "The server URL plus your topic. For protected topics use https://user:password@ntfy.example.com/topic or append ?auth=… .",
  },
  GOTIFY_WEBHOOK: {
    label: "Gotify",
    destination: "url",
    destinationLabel: "Server URL with app token",
    placeholder: "https://gotify.example.com/message?token=AbCdEf123456",
    hint: "Create an application in Gotify and append its token as ?token=… . The /message path is added if missing.",
  },
  EMAIL_INSTANT: {
    label: "Email",
    destination: "email",
    destinationLabel: "Recipient (optional)",
    placeholder: "Defaults to your GitHub email",
    hint: "Sent through the SMTP server set up in Settings → Email. Leave empty to use the email address of your account.",
  },
  CUSTOM_WEBHOOK: {
    label: "Custom webhook",
    destination: "url",
    destinationLabel: "Endpoint URL",
    placeholder: "https://example.com/hooks/repopulse",
    hint: 'Receives a JSON POST: { event: "release.published", repository, release, links }.',
  },
};

export function isDeliverableChannel(channel: string): channel is DeliverableChannel {
  return (DELIVERABLE_CHANNELS as readonly string[]).includes(channel);
}

export function channelLabel(channel: string): string {
  if (isDeliverableChannel(channel)) return CHANNEL_INFO[channel].label;
  if (channel === "IN_APP") return "In-app";
  if (channel === "EMAIL_DIGEST") return "Email digest";
  return channel;
}

/** Keeps a few characters of a secret path segment so rules stay distinguishable. */
function maskSegment(segment: string): string {
  if (segment.length <= 4) return "••••";
  return `${segment.slice(0, Math.min(4, Math.floor(segment.length / 3)))}••••`;
}

/**
 * A display form of a destination that hides secrets: webhook URLs carry tokens in the last
 * path segment (Discord, Slack, ntfy topics) or in the query (Gotify), and may embed credentials.
 */
export function maskDestination(channel: string, destination: string | null): string {
  if (!destination) return channel === "EMAIL_INSTANT" ? "Your account email" : "—";
  if (channel === "EMAIL_INSTANT" || channel === "EMAIL_DIGEST") return destination;
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return "Invalid URL";
  }
  const segments = url.pathname.split("/").filter(Boolean);
  // A secret in the query (Gotify's ?token=) leaves the path readable; otherwise the last segment is the secret.
  if (!url.search) {
    const last = segments.pop();
    if (last !== undefined) segments.push(maskSegment(decodeURIComponent(last)));
  }
  const path = segments.join("/");
  return `${url.host}${path ? `/${path}` : ""}${url.search ? "?••••" : ""}`;
}
