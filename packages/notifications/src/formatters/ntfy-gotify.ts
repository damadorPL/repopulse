import { WebhookUrlError } from "../errors.js";
import { releaseKindLabel, releaseSummary, truncateBytes, truncateText } from "../markdown.js";
import type { MessageContext } from "../types.js";

export interface PreparedRequest {
  url: URL;
  headers: Record<string, string>;
  body: string;
}

/** ntfy turns messages over 4096 bytes into attachments; stay below that. */
const NTFY_BODY_LIMIT_BYTES = 3800;
const GOTIFY_MESSAGE_LIMIT = 3800;

/** HTTP headers must be Latin-1; ntfy decodes RFC 2047 encoded words for anything else. */
export function encodeHeaderValue(value: string): string {
  const singleLine = value.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(singleLine) ? singleLine : `=?UTF-8?B?${Buffer.from(singleLine, "utf8").toString("base64")}?=`;
}

function pushBody(ctx: MessageContext): string {
  const { release } = ctx;
  const heading = release.title && release.title !== release.tagName ? `**${release.title}**\n\n` : "";
  const test = ctx.test ? "_This is a test notification from RepoPulse._\n\n" : "";
  return `${test}${heading}${releaseSummary(release)}`;
}

/**
 * ntfy: the topic URL receives the Markdown body; title, priority, tags and the click target
 * travel as headers (https://docs.ntfy.sh/publish/).
 */
export function buildNtfyRequest(ctx: MessageContext, destinationUrl: string): PreparedRequest {
  const { release, repository } = ctx;
  return {
    url: new URL(destinationUrl),
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Title: encodeHeaderValue(truncateText(`New Release: ${repository.fullName} ${release.tagName}`, 250)),
      Priority: release.semverType === "MAJOR" ? "high" : "default",
      Tags: "package,rocket",
      Click: release.htmlUrl,
      Markdown: "yes",
      Actions: `view, Open in RepoPulse, ${ctx.readerUrl}`,
    },
    body: truncateBytes(pushBody(ctx), NTFY_BODY_LIMIT_BYTES),
  };
}

/**
 * Gotify's `POST /message`. The app token may be given as `?token=`; it is moved into the
 * `X-Gotify-Key` header so it never shows up in proxy access logs. The `/message` path is
 * appended when the URL only names the server (also behind a sub-path).
 */
export function resolveGotifyEndpoint(destinationUrl: string): { url: URL; token: string } {
  const url = new URL(destinationUrl);
  const token = url.searchParams.get("token") ?? "";
  if (!token) throw new WebhookUrlError("The Gotify URL needs the application token, e.g. https://gotify.example.com/message?token=…");
  url.searchParams.delete("token");
  if (!/\/message\/?$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/+$/, "")}/message`;
  return { url, token };
}

export interface GotifyMessage {
  title: string;
  message: string;
  priority: number;
  extras: {
    "client::display": { contentType: "text/markdown" };
    "client::notification": { click: { url: string } };
  };
}

export function formatGotifyMessage(ctx: MessageContext): GotifyMessage {
  const { release, repository } = ctx;
  return {
    title: truncateText(`New Release: ${repository.fullName} ${release.tagName}`, 250),
    message: `${truncateText(pushBody(ctx), GOTIFY_MESSAGE_LIMIT)}\n\n${releaseKindLabel(release)} · [Open in RepoPulse](${ctx.readerUrl})`,
    priority: release.semverType === "MAJOR" ? 8 : 5,
    extras: {
      "client::display": { contentType: "text/markdown" },
      "client::notification": { click: { url: release.htmlUrl } },
    },
  };
}

export function buildGotifyRequest(ctx: MessageContext, destinationUrl: string): PreparedRequest {
  const { url, token } = resolveGotifyEndpoint(destinationUrl);
  return {
    url,
    headers: { "Content-Type": "application/json", "X-Gotify-Key": token },
    body: JSON.stringify(formatGotifyMessage(ctx)),
  };
}
