"use server";

import { createElement, type ReactNode } from "react";
import { z } from "zod";
import { ChangelogMarkdown } from "@/components/reader/changelog-markdown";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { FEED_PAGE_SIZE, parseFeedFilters } from "@/lib/feed-filters";
import { fail, invalidInput, ok, toActionError, type ActionResult } from "@/server/action-result";
import {
  getReleaseDetail,
  getReleaseFeed,
  getUserFeedContext,
  type FeedItem,
  type FeedPage,
} from "@/server/queries/feed";

const drawerInput = z.object({
  releaseId: z.string().min(1).max(64),
});

/**
 * Loads one release's drawer metadata and server-rendered sanitized changelog (`ReactNode`)
 * without re-rendering the entire dashboard page. Raw markdown never leaves the server.
 */
export async function getReleaseDrawerAction(input: {
  releaseId: string;
}): Promise<ActionResult<{ detail: FeedItem; content: ReactNode }>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = drawerInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);

    const detail = await getReleaseDetail(user.id, parsed.data.releaseId);
    if (!detail) return fail("NOT_FOUND", "Release not found.");

    const { bodyMarkdown, repositoryLastPolledAt: _polled, ...item } = detail;
    return ok({ detail: item, content: createElement(ChangelogMarkdown, { markdown: bodyMarkdown }) });
  } catch (error) {
    return toActionError(error, "getReleaseDrawerAction");
  }
}

/**
 * "Load more" for the release feed. Takes the feed's query string (same parsing as the page)
 * so client and server can never disagree on filter semantics.
 */
export async function loadMoreReleasesAction(input: {
  query: string;
  cursor: string;
}): Promise<ActionResult<FeedPage>> {
  try {
    const user = await getCurrentUserOrThrow();
    const query = typeof input.query === "string" ? input.query.slice(0, 1000) : "";
    const cursor = typeof input.cursor === "string" && input.cursor.length <= 100 ? input.cursor : null;
    if (!cursor) return ok({ items: [], nextCursor: null });

    const context = await getUserFeedContext(user.id);
    const page = await getReleaseFeed({
      userId: user.id,
      ...parseFeedFilters(new URLSearchParams(query)),
      subscriptions: context.subscriptionVisibility,
      repoContextById: context.repoContextById,
      cursor,
      limit: FEED_PAGE_SIZE,
    });
    return ok(page);
  } catch (error) {
    return toActionError(error, "loadMoreReleasesAction");
  }
}
