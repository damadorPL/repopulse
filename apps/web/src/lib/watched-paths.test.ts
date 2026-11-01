import { describe, expect, it } from "vitest";
import { commitMatchesAnyPath, summarizeWatchedPaths, validateWatchedPaths } from "./watched-paths";

describe("validateWatchedPaths", () => {
  it("returns normalized, deduplicated paths", () => {
    expect(validateWatchedPaths(" CHANGELOG.md, ./packages/cli/\npackages/cli ")).toEqual({
      ok: true,
      paths: ["CHANGELOG.md", "packages/cli"],
    });
    expect(validateWatchedPaths(["/docs/", "src"])).toEqual({ ok: true, paths: ["docs", "src"] });
  });

  it("names the first invalid entry", () => {
    expect(validateWatchedPaths("docs, ../secrets")).toEqual({
      ok: false,
      message: '"../secrets" is not a valid path. Use a path relative to the repository root, like packages/cli.',
    });
  });

  it("requires at least one and at most 10 paths", () => {
    expect(validateWatchedPaths(" , \n ")).toEqual({ ok: false, message: "Enter at least one file or folder path." });
    expect(validateWatchedPaths(Array.from({ length: 11 }, (_, i) => `p${i}`))).toEqual({ ok: false, message: "Watch at most 10 paths." });
  });
});

describe("formatting", () => {
  it("summarizes for cards", () => {
    expect(summarizeWatchedPaths(["a"])).toBe("a");
    expect(summarizeWatchedPaths(["a", "b"])).toBe("a, b");
    expect(summarizeWatchedPaths(["a", "b", "c"])).toBe("a +2 more");
  });
});

describe("commitMatchesAnyPath", () => {
  it("matches files and folder contents", () => {
    expect(commitMatchesAnyPath(["packages/db/schema.prisma"], ["packages/db"])).toBe(true);
    expect(commitMatchesAnyPath(["packages/dbx/a.ts"], ["packages/db"])).toBe(false);
  });
});
