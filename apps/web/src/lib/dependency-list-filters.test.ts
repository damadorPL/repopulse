import { describe, expect, it } from "vitest";
import {
  applyDependencyListFilters,
  dependencyListHref,
  dependencyListHrefFrom,
  dependencyProjectHref,
  filterUpdateRows,
  parseDependencyListFilters,
  type DependencyListRow,
} from "./dependency-list-filters";

const counts = (major = 0, minor = 0, patch = 0) => ({ major, minor, patch, other: 0 });

function row(fullName: string, outdated = counts(), lastScannedAt: Date | null = null, packageManagers: string[] = []): DependencyListRow {
  return { fullName, outdated, lastScannedAt, packageManagers };
}

describe("parseDependencyListFilters / href", () => {
  it("parses and normalizes", () => {
    expect(parseDependencyListFilters({ q: "  web ", sort: "outdated" })).toEqual({ q: "web", sort: "outdated" });
    expect(parseDependencyListFilters(new URLSearchParams("sort=bogus"))).toEqual({ q: undefined, sort: "name" });
  });

  it("round-trips through the URL, omitting defaults", () => {
    expect(dependencyListHref({ sort: "name" })).toBe("/dependencies");
    expect(dependencyListHref({ q: "a b", sort: "checked" })).toBe("/dependencies?q=a+b&sort=checked");
    expect(dependencyProjectHref("Vercel/Next.js", { q: "x" })).toBe("/dependencies/Vercel/Next.js?from=q%3Dx");
    expect(dependencyListHrefFrom("q=x&sort=outdated")).toBe("/dependencies?q=x&sort=outdated");
    expect(dependencyListHrefFrom("https://evil.example")).toBe("/dependencies");
  });
});

describe("applyDependencyListFilters", () => {
  const rows = [
    row("b/web", counts(0, 3), new Date("2026-01-02"), ["PNPM"]),
    row("a/api", counts(1, 0), new Date("2026-01-01"), ["UV"]),
    row("c/cli", counts(0, 0, 9), null, ["NPM"]),
  ];

  it("searches every word in name and package managers", () => {
    expect(applyDependencyListFilters(rows, { q: "uv", sort: "name" }).map((r) => r.fullName)).toEqual(["a/api"]);
    expect(applyDependencyListFilters(rows, { q: "web pnpm", sort: "name" }).map((r) => r.fullName)).toEqual(["b/web"]);
  });

  it("sorts by name, outdated (majors first) and last check (never last)", () => {
    expect(applyDependencyListFilters(rows, { sort: "name" }).map((r) => r.fullName)).toEqual(["a/api", "b/web", "c/cli"]);
    expect(applyDependencyListFilters(rows, { sort: "outdated" }).map((r) => r.fullName)).toEqual(["a/api", "c/cli", "b/web"]);
    expect(applyDependencyListFilters(rows, { sort: "checked" }).map((r) => r.fullName)).toEqual(["b/web", "a/api", "c/cli"]);
  });
});

describe("filterUpdateRows", () => {
  const updates = [
    { name: "react", kind: "PROD" as const, ecosystem: "NPM" as const, status: "OUTDATED" as const, level: "MAJOR" },
    { name: "vitest", kind: "DEV" as const, ecosystem: "NPM" as const, status: "TOO_NEW" as const, level: "MINOR" },
    { name: "django", kind: "PROD" as const, ecosystem: "PYPI" as const, status: "OUTDATED" as const, level: null },
  ];

  it("combines level, kind, ecosystem, status and name filters", () => {
    expect(filterUpdateRows(updates, {}).length).toBe(3);
    expect(filterUpdateRows(updates, { level: "OTHER" }).map((u) => u.name)).toEqual(["django"]);
    expect(filterUpdateRows(updates, { kind: "PROD", ecosystem: "NPM" }).map((u) => u.name)).toEqual(["react"]);
    expect(filterUpdateRows(updates, { status: "OUTDATED", q: "DJ" }).map((u) => u.name)).toEqual(["django"]);
  });
});
