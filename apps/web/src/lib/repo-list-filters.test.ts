import { describe, expect, it } from "vitest";
import {
  applyRepoListFilters,
  DEFAULT_REPO_LIST_FILTERS,
  hasActiveRepoListFilters,
  parseRepoListFilters,
  repoListHref,
  repoListHrefFrom,
  repositorySettingsHref,
  type RepoListFilters,
  type RepoListRow,
} from "./repo-list-filters";

const day = (n: number) => new Date(Date.UTC(2026, 9, n));

type RowExtra = Partial<Omit<RepoListRow, "repository">> & { repository?: Partial<RepoListRow["repository"]> };

function row(fullName: string, extra: RowExtra = {}): RepoListRow {
  const { repository, ...rest } = extra;
  return {
    isPinned: false,
    trackPaths: false,
    watchedPaths: [],
    subscribedAt: day(1),
    latestActivityAt: null,
    note: null,
    tags: [],
    ...rest,
    repository: {
      id: fullName,
      fullName,
      description: null,
      starsCount: 0,
      lastPolledAt: null,
      pollStatus: "IDLE",
      ...repository,
    },
  };
}

const filters = (extra: Partial<RepoListFilters> = {}): RepoListFilters => ({ ...DEFAULT_REPO_LIST_FILTERS, ...extra });
const names = (rows: RepoListRow[]) => rows.map((r) => r.repository.fullName);

describe("parseRepoListFilters / repoListHref", () => {
  it("defaults to name order with nothing else", () => {
    expect(parseRepoListFilters({})).toEqual({ q: undefined, sort: "name", tagSlug: undefined, statuses: [] });
    expect(repoListHref(parseRepoListFilters({}))).toBe("/repositories");
  });

  it("round-trips search, sort, tag and statuses", () => {
    const parsed = parseRepoListFilters(new URLSearchParams("q=next&sort=-added&tag=frontend&status=pinned,unread"));
    expect(parsed).toEqual({ q: "next", sort: "-added", tagSlug: "frontend", statuses: ["unread", "pinned"] });
    expect(repoListHref(parsed)).toBe("/repositories?q=next&sort=-added&tag=frontend&status=unread%2Cpinned");
    expect(parseRepoListFilters(new URL(`http://x${repoListHref(parsed)}`).searchParams)).toEqual(parsed);
  });

  it("ignores unknown sorts, statuses and unsafe tag slugs, and caps the query", () => {
    const parsed = parseRepoListFilters({ sort: "bogus", status: "nope,error,error", tag: "../x", q: "a".repeat(500) });
    expect(parsed.sort).toBe("name");
    expect(parsed.statuses).toEqual(["error"]);
    expect(parsed.tagSlug).toBeUndefined();
    expect(parsed.q).toHaveLength(200);
  });

  it("reads the first value of repeated params", () => {
    expect(parseRepoListFilters({ q: ["one", "two"] }).q).toBe("one");
  });

  it("hasActiveRepoListFilters ignores the sort", () => {
    expect(hasActiveRepoListFilters(filters({ sort: "stars" }))).toBe(false);
    expect(hasActiveRepoListFilters(filters({ q: "x" }))).toBe(true);
    expect(hasActiveRepoListFilters(filters({ statuses: ["pinned"] }))).toBe(true);
  });
});

describe("repositorySettingsHref / repoListHrefFrom", () => {
  it("links to the settings page and carries the list state in ?from=", () => {
    expect(repositorySettingsHref("vercel/next.js")).toBe("/repositories/vercel/next.js");
    expect(repositorySettingsHref("vercel/next.js", filters())).toBe("/repositories/vercel/next.js");
    expect(repositorySettingsHref("vercel/next.js", filters({ q: "next", sort: "stars" }))).toBe(
      "/repositories/vercel/next.js?from=q%3Dnext%26sort%3Dstars",
    );
  });

  it("returns to the list with the same filters, and only to the list", () => {
    expect(repoListHrefFrom("q=next&sort=stars")).toBe("/repositories?q=next&sort=stars");
    expect(repoListHrefFrom(undefined)).toBe("/repositories");
    expect(repoListHrefFrom("https://evil.example/")).toBe("/repositories");
    expect(repoListHrefFrom(["sort=unread", "sort=stars"])).toBe("/repositories?sort=unread");
  });
});

describe("applyRepoListFilters", () => {
  const unread = new Map([
    ["acme/api", 3],
    ["acme/web", 1],
  ]);
  const rows = [
    row("acme/web", { subscribedAt: day(5), latestActivityAt: day(9), repository: { starsCount: 50, lastPolledAt: day(2) } }),
    row("acme/api", {
      subscribedAt: day(1),
      latestActivityAt: day(3),
      tags: [{ name: "Backend", slug: "backend" }],
      repository: { description: "The public REST API", starsCount: 10, lastPolledAt: day(4), pollStatus: "ERROR" },
    }),
    row("vercel/next.js", {
      subscribedAt: day(3),
      trackPaths: true,
      watchedPaths: ["packages/next/src"],
      note: "Blocked on v16 because of the router",
      tags: [{ name: "Frontend", slug: "frontend" }],
      repository: { starsCount: 120000 },
    }),
    row("zeta/tool", { subscribedAt: day(4) }),
  ];

  it("sorts by name by default and keeps the input intact", () => {
    expect(names(applyRepoListFilters(rows, filters(), unread))).toEqual(["acme/api", "acme/web", "vercel/next.js", "zeta/tool"]);
    expect(names(rows)[0]).toBe("acme/web");
  });

  it("supports every sort", () => {
    const sorted = (sort: RepoListFilters["sort"]) => names(applyRepoListFilters(rows, filters({ sort }), unread));
    expect(sorted("-name")).toEqual(["zeta/tool", "vercel/next.js", "acme/web", "acme/api"]);
    expect(sorted("added")).toEqual(["acme/api", "vercel/next.js", "zeta/tool", "acme/web"]);
    expect(sorted("-added")).toEqual(["acme/web", "zeta/tool", "vercel/next.js", "acme/api"]);
    expect(sorted("stars")).toEqual(["vercel/next.js", "acme/web", "acme/api", "zeta/tool"]);
    // Ties (no unread) fall back to the name.
    expect(sorted("unread")).toEqual(["acme/api", "acme/web", "vercel/next.js", "zeta/tool"]);
  });

  it("sorts by latest update and last sync newest first, nulls last, ties by name", () => {
    expect(names(applyRepoListFilters(rows, filters({ sort: "updated" }), unread))).toEqual([
      "acme/web",
      "acme/api",
      "vercel/next.js",
      "zeta/tool",
    ]);
    expect(names(applyRepoListFilters(rows, filters({ sort: "synced" }), unread))).toEqual([
      "acme/api",
      "acme/web",
      "vercel/next.js",
      "zeta/tool",
    ]);
  });

  it("puts pinned repositories first within any sort", () => {
    const pinned = rows.map((r) => (r.repository.fullName === "zeta/tool" || r.repository.fullName === "acme/web" ? { ...r, isPinned: true } : r));
    expect(names(applyRepoListFilters(pinned, filters(), unread))).toEqual(["acme/web", "zeta/tool", "acme/api", "vercel/next.js"]);
    expect(names(applyRepoListFilters(pinned, filters({ sort: "stars" }), unread))).toEqual([
      "acme/web",
      "zeta/tool",
      "vercel/next.js",
      "acme/api",
    ]);
  });

  it("searches name, description, tags, note and watched paths case-insensitively, every word must match", () => {
    const search = (q: string) => names(applyRepoListFilters(rows, filters({ q }), unread));
    expect(search("ACME")).toEqual(["acme/api", "acme/web"]);
    expect(search("rest api")).toEqual(["acme/api"]);
    expect(search("backend")).toEqual(["acme/api"]);
    expect(search("router")).toEqual(["vercel/next.js"]);
    expect(search("packages/next")).toEqual(["vercel/next.js"]);
    expect(search("acme frontend")).toEqual([]);
  });

  it("filters by tag and status chips (AND)", () => {
    expect(names(applyRepoListFilters(rows, filters({ tagSlug: "frontend" }), unread))).toEqual(["vercel/next.js"]);
    expect(names(applyRepoListFilters(rows, filters({ statuses: ["unread"] }), unread))).toEqual(["acme/api", "acme/web"]);
    expect(names(applyRepoListFilters(rows, filters({ statuses: ["unread", "error"] }), unread))).toEqual(["acme/api"]);
    expect(names(applyRepoListFilters(rows, filters({ statuses: ["paths"] }), unread))).toEqual(["vercel/next.js"]);
    expect(names(applyRepoListFilters(rows, filters({ statuses: ["pinned"] }), unread))).toEqual([]);
  });
});
