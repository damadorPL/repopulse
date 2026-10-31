import { describe, expect, it } from "vitest";
import { feedFiltersKey, feedHref, parseFeedFilters, parseReleaseParam } from "./feed-filters";

describe("parseFeedFilters", () => {
  it("defaults to all releases, newest first", () => {
    expect(parseFeedFilters({})).toEqual({
      tagSlug: undefined,
      repositoryId: undefined,
      onlyUnread: false,
      semverType: undefined,
      searchQuery: undefined,
      sort: "newest",
    });
  });

  it("parses every filter from search params", () => {
    const filters = parseFeedFilters(
      new URLSearchParams("tag=self-hosted&repo=clx123&unread=1&semver=major&q=%20breaking%20&sort=oldest"),
    );
    expect(filters).toEqual({
      tagSlug: "self-hosted",
      repositoryId: "clx123",
      onlyUnread: true,
      semverType: "MAJOR",
      searchQuery: "breaking",
      sort: "oldest",
    });
  });

  it("ignores unknown or malformed values instead of querying with them", () => {
    const filters = parseFeedFilters({ tag: "../../etc", semver: "huge", sort: "random", unread: "yes", repo: "a b" });
    expect(filters.tagSlug).toBeUndefined();
    expect(filters.repositoryId).toBeUndefined();
    expect(filters.semverType).toBeUndefined();
    expect(filters.sort).toBe("newest");
    expect(filters.onlyUnread).toBe(false);
  });

  it("uses the first value of repeated params and caps the search length", () => {
    const filters = parseFeedFilters({ tag: ["a", "b"], q: "x".repeat(500) });
    expect(filters.tagSlug).toBe("a");
    expect(filters.searchQuery).toHaveLength(200);
  });
});

describe("feedHref", () => {
  it("omits defaults", () => {
    expect(feedHref()).toBe("/");
    expect(feedHref({ onlyUnread: false, sort: "newest" })).toBe("/");
  });

  it("round-trips through parseFeedFilters", () => {
    const filters = parseFeedFilters({ tag: "critical", unread: "1", semver: "PATCH", q: "fix & feat", sort: "oldest" });
    const href = feedHref(filters, "rel_1");
    const params = new URLSearchParams(href.slice(2));
    expect(parseFeedFilters(params)).toEqual(filters);
    expect(parseReleaseParam(params)).toBe("rel_1");
  });

  it("keys filter combinations without the open release", () => {
    const filters = parseFeedFilters({ tag: "critical" });
    expect(feedFiltersKey(filters)).toBe("tag=critical");
  });
});
