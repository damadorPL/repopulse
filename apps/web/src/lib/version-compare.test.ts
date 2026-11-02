import { describe, expect, it } from "vitest";
import {
  compareVersions,
  computeVersionStatus,
  findVersionRow,
  formatVersionStatus,
  isNewerThanVersion,
  parseVersion,
  versionTagCandidates,
  type VersionRow,
} from "./version-compare";

const day = (n: number) => new Date(Date.UTC(2026, 0, n));
const row = (tagName: string, n: number, semverType = "MINOR"): VersionRow => ({ tagName, publishedAt: day(n), semverType });

describe("parseVersion", () => {
  it("normalizes common tag shapes", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion("release-1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion("@scope/pkg@4.0.0-beta.2")).toEqual({ major: 4, minor: 0, patch: 0, prerelease: ["beta", "2"] });
    expect(parseVersion("coolify@4.0.0-beta.380")).toMatchObject({ major: 4, prerelease: ["beta", "380"] });
    expect(parseVersion("v2")).toEqual({ major: 2, minor: 0, patch: 0, prerelease: [] });
  });

  it("returns null without a number", () => {
    expect(parseVersion("nightly")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by SemVer precedence", () => {
    expect(compareVersions("v1.10.0", "v1.9.9")).toBe(1);
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
    expect(compareVersions("v2.0.0-rc.1", "v2.0.0")).toBe(-1);
    expect(compareVersions("v2.0.0", "v2.0.0-rc.1")).toBe(1);
    expect(compareVersions("v2.0.0-rc.2", "v2.0.0-rc.10")).toBe(-1);
    expect(compareVersions("v2.0.0-alpha", "v2.0.0-beta")).toBe(-1);
    expect(compareVersions("v2.0.0-1", "v2.0.0-alpha")).toBe(-1);
    expect(compareVersions("v2.0.0-rc", "v2.0.0-rc.1")).toBe(-1);
  });

  it("is null when either side is not a version", () => {
    expect(compareVersions("nightly", "v1.0.0")).toBeNull();
    expect(compareVersions("v1.0.0", "latest")).toBeNull();
  });
});

describe("versionTagCandidates / findVersionRow", () => {
  it("accepts the typed text and its v-prefix variant", () => {
    expect(versionTagCandidates("1.2.3")).toEqual(["1.2.3", "v1.2.3"]);
    expect(versionTagCandidates("v1.2.3")).toEqual(["v1.2.3", "1.2.3"]);
    expect(versionTagCandidates("  ")).toEqual([]);
    expect(versionTagCandidates("stable")).toEqual(["stable", "vstable"]);
  });

  it("prefers an exact tag over a variant", () => {
    const rows = [row("v1.2.3", 1), row("1.2.3", 2)];
    expect(findVersionRow(rows, "1.2.3")?.publishedAt).toEqual(day(2));
    expect(findVersionRow(rows, "v1.2.3")?.publishedAt).toEqual(day(1));
    expect(findVersionRow([row("v1.2.3", 1)], "1.2.3")?.tagName).toBe("v1.2.3");
    expect(findVersionRow(rows, "9.9.9")).toBeNull();
  });
});

describe("isNewerThanVersion", () => {
  it("compares by publication date when a stored row matches", () => {
    expect(isNewerThanVersion(row("v1.0.1", 5), "v1.2.0", day(3))).toBe(true); // published later wins, even if lower
    expect(isNewerThanVersion(row("v1.3.0", 2), "v1.2.0", day(3))).toBe(false);
  });

  it("falls back to SemVer without a matching row", () => {
    expect(isNewerThanVersion(row("v1.3.0", 1), "1.2.0", null)).toBe(true);
    expect(isNewerThanVersion(row("v1.1.0", 9), "1.2.0", null)).toBe(false);
    expect(isNewerThanVersion(row("nightly", 9), "1.2.0", null)).toBe(false);
  });

  it("never marks the user's own version", () => {
    expect(isNewerThanVersion(row("v1.2.0", 9), "1.2.0", day(1))).toBe(false);
  });
});

describe("computeVersionStatus", () => {
  const rows = [
    row("v3.1.0", 10),
    row("v3.0.0", 9, "MAJOR"),
    row("v2.5.1", 8, "PATCH"),
    row("v2.5.0", 7),
    row("v2.4.0", 6),
    row("v2.0.0", 1, "MAJOR"),
  ];

  it("counts the visible rows newer than the matching tag, and the majors among them", () => {
    expect(computeVersionStatus(rows, "v2.5.0")).toEqual({ behind: 3, major: 1, matched: true });
    expect(computeVersionStatus(rows, "2.5.0")).toEqual({ behind: 3, major: 1, matched: true });
    expect(computeVersionStatus(rows, "v3.1.0")).toEqual({ behind: 0, major: 0, matched: true });
  });

  it("falls back to SemVer for a version older than the stored history", () => {
    expect(computeVersionStatus(rows, "1.9.0")).toEqual({ behind: 6, major: 2, matched: false });
  });

  it("is null when unset or not comparable", () => {
    expect(computeVersionStatus(rows, null)).toBeNull();
    expect(computeVersionStatus(rows, "")).toBeNull();
    expect(computeVersionStatus(rows, "stable")).toBeNull();
  });

  it("formats the status", () => {
    expect(formatVersionStatus({ behind: 0, major: 0, matched: true })).toBe("Up to date");
    expect(formatVersionStatus({ behind: 1, major: 0, matched: true })).toBe("1 release behind");
    expect(formatVersionStatus({ behind: 3, major: 1, matched: false })).toBe("3 releases behind · 1 major");
  });
});
