import { truncateText } from "../markdown.js";
import type { MessageContext } from "../types.js";

/** Large enough for nearly every changelog; keeps the request size bounded. */
const BODY_LIMIT = 20_000;

export interface CustomWebhookPayload {
  event: "release.published";
  test: boolean;
  repository: { fullName: string; htmlUrl: string };
  release: {
    id: string;
    tagName: string;
    title: string;
    semverType: string;
    isPrerelease: boolean;
    source: "RELEASE" | "TAG" | "COMMIT";
    publishedAt: string;
    htmlUrl: string;
    bodyMarkdown: string;
  };
  rule: { id: string; tag: string | null };
  links: { repopulse: string; github: string };
}

/** Generic JSON for user-built integrations (n8n, Home Assistant, scripts). */
export function formatCustomWebhookPayload(ctx: MessageContext): CustomWebhookPayload {
  const { release, repository, rule } = ctx;
  return {
    event: "release.published",
    test: ctx.test === true,
    repository: { fullName: repository.fullName, htmlUrl: repository.htmlUrl },
    release: {
      id: release.id,
      tagName: release.tagName,
      title: release.title,
      semverType: release.semverType,
      isPrerelease: release.isPrerelease,
      source: release.source ?? "RELEASE",
      publishedAt: release.publishedAt.toISOString(),
      htmlUrl: release.htmlUrl,
      bodyMarkdown: truncateText(release.bodyMarkdown, BODY_LIMIT),
    },
    rule: { id: rule.id, tag: rule.tag?.name ?? null },
    links: { repopulse: ctx.readerUrl, github: release.htmlUrl },
  };
}
