"use server";

import { getCurrentUserOrThrow } from "@/lib/auth";
import { FEED_PAGE_SIZE, parseFeedFilters } from "@/lib/feed-filters";
import { ok, toActionError, type ActionResult } from "@/server/action-result";
import { getReleaseFeed, type FeedPage } from "@/server/queries/feed";

/**
 * "Load more" for the release feed. Takes the feed's query string (same parsing as the page)
 * so client and server can never disagree on filter semantics.
 */
export async function loadMoreReleasesAction(input: { query: string; cursor: string }): Promise<ActionResult<FeedPage>> {
  try {
    const user = await getCurrentUserOrThrow();
    const query = typeof input.query === "string" ? input.query.slice(0, 1000) : "";
    const cursor = typeof input.cursor === "string" && input.cursor.length <= 100 ? input.cursor : null;
    if (!cursor) return ok({ items: [], nextCursor: null });

    const page = await getReleaseFeed({
      userId: user.id,
      ...parseFeedFilters(new URLSearchParams(query)),
      cursor,
      limit: FEED_PAGE_SIZE,
    });
    return ok(page);
  } catch (error) {
    return toActionError(error, "loadMoreReleasesAction");
  }
}
