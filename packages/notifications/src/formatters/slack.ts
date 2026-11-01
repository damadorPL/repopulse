import { markdownToSlack, releaseKindLabel, releaseSummary, truncateText } from "../markdown.js";
import type { MessageContext } from "../types.js";

/** Slack limits: header text 150 characters, section text 3000, button URL 3000. */
const HEADER_LIMIT = 150;
const SECTION_LIMIT = 2900;

type TextObject = { type: "plain_text"; text: string; emoji?: boolean } | { type: "mrkdwn"; text: string };

export interface SlackWebhookPayload {
  text: string;
  blocks: Array<
    | { type: "header"; text: TextObject }
    | { type: "context"; elements: TextObject[] }
    | { type: "section"; text: TextObject }
    | {
        type: "actions";
        elements: Array<{ type: "button"; text: TextObject; url: string; style?: "primary"; action_id: string }>;
      }
  >;
  unfurl_links: boolean;
  unfurl_media: boolean;
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Slack Block Kit: header (repo + version), context line, summary section, two link buttons. */
export function formatSlackPayload(ctx: MessageContext): SlackWebhookPayload {
  const { release, repository, rule } = ctx;
  const headline = `${repository.fullName} ${release.tagName}`;
  const context = [
    `*${releaseKindLabel(release)}*`,
    release.title && release.title !== release.tagName ? escapeSlack(release.title) : null,
    rule.tag ? `Tag: ${escapeSlack(rule.tag.name)}` : null,
    ctx.test ? "_Test notification_" : null,
  ]
    .filter(Boolean)
    .join("  ·  ");

  return {
    // Fallback for push notifications and clients without Block Kit.
    text: `New release: ${headline}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: truncateText(headline, HEADER_LIMIT), emoji: true } },
      { type: "context", elements: [{ type: "mrkdwn", text: context }] },
      { type: "section", text: { type: "mrkdwn", text: truncateText(markdownToSlack(releaseSummary(release)), SECTION_LIMIT) } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open in RepoPulse" },
            url: ctx.readerUrl,
            style: "primary",
            action_id: "open_repopulse",
          },
          {
            type: "button",
            text: { type: "plain_text", text: release.source === "TAG" ? "View on GitHub" : "Release notes on GitHub" },
            url: release.htmlUrl,
            action_id: "open_github",
          },
        ],
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}
