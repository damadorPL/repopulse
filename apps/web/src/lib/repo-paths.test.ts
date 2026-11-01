import { describe, expect, it } from "vitest";
import {
  addCoveringPath,
  buildRepoPathIndex,
  coveringPath,
  looksLikeRepository,
  parentOf,
  searchRepoPaths,
} from "./repo-paths";

const index = buildRepoPathIndex({
  dirs: ["docs", "packages", "packages/cli", "packages/cli/src", "packages/core"],
  files: [
    "CHANGELOG.md",
    "README.md",
    "docs/changelog-guide.md",
    "packages/cli/CHANGELOG.md",
    "packages/cli/src/index.ts",
    "packages/core/package.json",
  ],
});

const paths = (query: string, limit?: number) => searchRepoPaths(index, query, limit).map((s) => s.path);

describe("buildRepoPathIndex", () => {
  it("lists children with folders first, then files by name", () => {
    expect(index.children.get("")!.map((e) => e.path)).toEqual(["docs", "packages", "CHANGELOG.md", "README.md"]);
    expect(index.children.get("packages/cli")!.map((e) => e.name)).toEqual(["src", "CHANGELOG.md"]);
    expect(index.kinds.get("packages/core")).toBe("dir");
  });

  it("finds parents", () => {
    expect(parentOf("packages/cli/src")).toBe("packages/cli");
    expect(parentOf("README.md")).toBe("");
  });
});

describe("searchRepoPaths", () => {
  it("lists the root for an empty query", () => {
    expect(paths("")).toEqual(["docs", "packages", "CHANGELOG.md", "README.md"]);
  });

  it("ranks path prefixes, then name prefixes (shallower first), then substrings", () => {
    expect(paths("changelog")).toEqual(["CHANGELOG.md", "docs/changelog-guide.md", "packages/cli/CHANGELOG.md"]);
    expect(paths("guide")).toEqual(["docs/changelog-guide.md"]);
    expect(paths("packages/c")).toEqual(["packages/cli", "packages/core", "packages/cli/src", "packages/cli/CHANGELOG.md", "packages/core/package.json", "packages/cli/src/index.ts"]);
  });

  it("puts the exact path first and accepts a trailing slash or ./ prefix", () => {
    expect(paths("packages")[0]).toBe("packages");
    expect(paths("packages/cli/")[0]).toBe("packages/cli");
    expect(paths("./docs")[0]).toBe("docs");
  });

  it("returns match positions for highlighting", () => {
    const [first] = searchRepoPaths(index, "index");
    expect(first).toMatchObject({ path: "packages/cli/src/index.ts", matchStart: "packages/cli/src/".length });
  });

  it("respects the limit and skips non-matches", () => {
    expect(paths("a", 2)).toHaveLength(2);
    expect(paths("zzz")).toEqual([]);
  });
});

describe("coveringPath / addCoveringPath", () => {
  it("finds the selected folder that already covers a path", () => {
    expect(coveringPath("packages/cli/src", ["docs", "packages/cli"])).toBe("packages/cli");
    expect(coveringPath("packages/cli", ["packages/cli"])).toBe("packages/cli");
    expect(coveringPath("packages/clix", ["packages/cli"])).toBeNull();
  });

  it("drops selected paths inside a newly added folder", () => {
    expect(addCoveringPath(["README.md", "packages/cli/src", "packages/clix"], "packages/cli")).toEqual([
      "README.md",
      "packages/clix",
      "packages/cli",
    ]);
  });
});

describe("looksLikeRepository", () => {
  it.each(["vercel/next.js", "https://github.com/vercel/next.js", "github.com/a-b/c_d"])("accepts %j", (input) => {
    expect(looksLikeRepository(input)).toBe(true);
  });

  it.each(["", "vercel", "vercel/", "/next.js"])("rejects %j", (input) => {
    expect(looksLikeRepository(input)).toBe(false);
  });
});
