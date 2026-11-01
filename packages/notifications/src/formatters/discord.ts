import { releaseKindLabel, releaseSummary, truncateText } from "../markdown.js";
import type { MessageContext, SemverType } from "../types.js";

export const DISCORD_COLORS: Record<SemverType, number> = {
  MAJOR: 0xef4444,
  MINOR: 0x3b82f6,
  PATCH: 0x10b981,
  PRERELEASE: 0xf59e0b,
  OTHER: 0x6b7280,
};

/** Discord allows 4096 characters per embed description; the summary is cut well before that. */
export const DISCORD_DESCRIPTION_LIMIT = 4096;
export const DISCORD_SUMMARY_LIMIT = 3800;
const TITLE_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;

export interface DiscordWebhookPayload {
  username: string;
  allowed_mentions: { parse: string[] };
  embeds: Array<{
    title: string;
    url: string;
    color: number;
    description: string;
    author?: { name: string; url: string; icon_url?: string };
    fields: Array<{ name: string; value: string; inline: boolean }>;
    footer: { text: string };
    timestamp: string;
  }>;
}

/** Discord Rich Embed. `allowed_mentions` stops release notes from pinging `@everyone` or roles. */
export function formatDiscordPayload(ctx: MessageContext): DiscordWebhookPayload {
  const { release, repository, rule } = ctx;
  const link = `\n\n[Read in RepoPulse](${ctx.readerUrl})`;
  const summary = truncateText(releaseSummary(release), DISCORD_SUMMARY_LIMIT);
  const description = truncateText(`${summary}${link}`, DISCORD_DESCRIPTION_LIMIT);

  const fields = [
    { name: "Version", value: truncateText(release.tagName, FIELD_VALUE_LIMIT), inline: true },
    { name: "Type", value: releaseKindLabel(release), inline: true },
  ];
  if (rule.tag) fields.push({ name: "Tag", value: truncateText(rule.tag.name, FIELD_VALUE_LIMIT), inline: true });

  return {
    username: "RepoPulse",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: truncateText(`${repository.fullName} ${release.tagName} released`, TITLE_LIMIT),
        url: release.htmlUrl,
        color: DISCORD_COLORS[release.semverType],
        description,
        author: {
          name: truncateText(repository.fullName, TITLE_LIMIT),
          url: repository.htmlUrl,
          ...(repository.avatarUrl ? { icon_url: repository.avatarUrl } : {}),
        },
        fields,
        footer: { text: ctx.test ? "RepoPulse · test notification" : "RepoPulse" },
        timestamp: release.publishedAt.toISOString(),
      },
    ],
  };
}
