import { describe, expect, it } from "vitest";
import {
  buildCommitMessage,
  buildPrBody,
  buildTargets,
  depsBranchName,
  depsPrMarker,
  escapeMarkdownText,
  formatTarget,
  markdownCodeSpan,
  groupKeyFromBranch,
  parseDepsPrMarker,
  parseTarget,
  PR_BODY_MAX_LENGTH,
  type PrUpdate,
} from "./pull-request.js";

const react: PrUpdate = {
  ecosystem: "NPM",
  name: "react",
  manifestPath: "apps/web/package.json",
  fromVersion: "19.2.0",
  toVersion: "19.3.0",
  level: "MINOR",
  releasedAt: new Date("2026-10-20T10:00:00Z"),
  sourceRepoUrl: "https://github.com/facebook/react",
};
const typesNode: PrUpdate = {
  ecosystem: "NPM",
  name: "@types/node",
  manifestPath: "package.json",
  fromVersion: null,
  toVersion: "24.1.0",
  level: "MAJOR",
  releasedAt: null,
  sourceRepoUrl: null,
};

describe("branch and marker", () => {
  it("builds and parses branch names", () => {
    expect(depsBranchName("all")).toBe("repopulse/deps/all");
    expect(groupKeyFromBranch("refs/heads/repopulse/deps/major-react")).toBe("major-react");
    expect(groupKeyFromBranch("main")).toBeNull();
    expect(() => depsBranchName("../main")).toThrow();
  });

  it("builds and parses the hidden marker", () => {
    expect(depsPrMarker("npm-react")).toBe("<!-- repopulse:deps:npm-react -->");
    expect(parseDepsPrMarker(`body\n${depsPrMarker("all")}`)).toBe("all");
    expect(parseDepsPrMarker(null)).toBeNull();
  });
});

describe("commit message and targets", () => {
  it("names a single dependency, otherwise counts", () => {
    expect(buildCommitMessage("chore(deps):", [react])).toBe("chore(deps): update react to 19.3.0");
    expect(buildCommitMessage("chore(deps):", [react, { ...react, manifestPath: "package.json" }])).toBe(
      "chore(deps): update react to 19.3.0",
    );
    expect(buildCommitMessage("chore(deps):", [react, { ...react, toVersion: "18.3.1" }])).toBe("chore(deps): update react");
    const seven = Array.from({ length: 7 }, (_, i) => ({ ...react, name: `dep${i}` }));
    expect(buildCommitMessage("chore(deps):", seven)).toBe("chore(deps): update 7 dependencies");
    expect(buildCommitMessage("  ", [react])).toBe("Update react to 19.3.0");
  });

  it("keeps scoped package names verbatim", () => {
    expect(buildCommitMessage("chore(deps):", [typesNode])).toBe("chore(deps): update @types/node to 24.1.0");
  });

  it("formats and parses targets", () => {
    expect(formatTarget(typesNode)).toBe("package.json#@types/node@24.1.0");
    expect(parseTarget("package.json#@types/node@24.1.0")).toEqual({ manifestPath: "package.json", name: "@types/node", version: "24.1.0" });
    expect(parseTarget("nope")).toBeNull();
    expect(buildTargets([react, typesNode, react])).toEqual(["apps/web/package.json#react@19.3.0", "package.json#@types/node@24.1.0"]);
  });
});

describe("buildPrBody", () => {
  it("renders the table, notes, footer and marker without raw mentions", () => {
    const body = buildPrBody({
      groupKey: "all",
      updates: [react, typesNode],
      skipped: [{ name: "@babel/core", manifestPath: "package.json", reason: "8.0.0 is younger than 3 days (@someone)" }],
      projectUrl: "https://repopulse.example.com/dependencies/acme/web",
    });
    expect(body).toContain("| Dependency | Manifest | Version | Level | Released | Changelog |");
    expect(body).toContain(
      "| `react` | `apps/web/package.json` | `19.2.0` → `19.3.0` | minor | 2026-10-20 | [releases](https://github.com/facebook/react/releases) · [npm](https://www.npmjs.com/package/react/v/19.3.0) |",
    );
    expect(body).toContain("| `@types/node` | `package.json` | — → `24.1.0` | major | — | [npm](https://www.npmjs.com/package/@types/node/v/24.1.0) |");
    expect(body).toContain("Opened by RepoPulse · settings: https://repopulse.example.com/dependencies/acme/web");
    expect(body.endsWith("<!-- repopulse:deps:all -->")).toBe(true);
    // Every `@` outside code spans and URLs is defused.
    const withoutCode = body.replace(/`[^`]*`/g, "").replace(/\]\([^)]*\)/g, "");
    expect(withoutCode).not.toMatch(/@(?!&#8203;)/);
    expect(body).toContain("@&#8203;someone");
  });

  it("wraps names in code spans whose fence outlasts any backtick run", () => {
    expect(markdownCodeSpan("@types/node")).toBe("`@types/node`");
    expect(markdownCodeSpan("a`b")).toBe("``a`b``");
    expect(markdownCodeSpan("a``b")).toBe("```a``b```");
    expect(markdownCodeSpan("`a")).toBe("`` `a ``");
    expect(markdownCodeSpan("a|b")).toBe("`a b`");
  });

  it("escapes markdown in free text", () => {
    expect(escapeMarkdownText("a|b *c* @d #1")).toBe("a\\|b \\*c\\* @&#8203;d #&#8203;1");
  });

  it("stays below the GitHub size limit and collapses huge skipped lists", () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({ ...react, name: `package-number-${i}`, manifestPath: `apps/app-${i}/package.json` }));
    const body = buildPrBody({ groupKey: "all", updates: many, projectUrl: "https://x" });
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX_LENGTH);
    expect(body).toMatch(/…and \d+ more/);
    expect(body.endsWith("<!-- repopulse:deps:all -->")).toBe(true);

    const manySkipped = Array.from({ length: 1000 }, (_, i) => ({
      name: `skipped-pkg-${i}`,
      manifestPath: `packages/pkg-${i}/package.json`,
      reason: ` blocked by policy constraint ${"x".repeat(60)}`,
    }));
    const skippedBody = buildPrBody({
      groupKey: "all",
      updates: [react],
      skipped: manySkipped,
      projectUrl: "https://x",
    });
    expect(skippedBody.length).toBeLessThanOrEqual(PR_BODY_MAX_LENGTH);
    expect(skippedBody).toContain("**Not included:** 1000 updates (see the project page).");
    expect(skippedBody.endsWith("<!-- repopulse:deps:all -->")).toBe(true);
  });
});
