import { describe, expect, it } from "vitest";
import {
  basename,
  deepEqual,
  detectLineEnding,
  dirname,
  isRecord,
  isWithinDir,
  joinPath,
  matchesWorkspaceGlobs,
  normalizePypiName,
  relativeTo,
  resolveRelativePath,
  stripBom,
  utf8ByteLength,
  workspaceGlobToRegExp,
} from "./util.js";

describe("resolveRelativePath", () => {
  it("rejects leading slashes, Windows drives, backslashes and NUL bytes", () => {
    expect(resolveRelativePath("dir", "/abs/path.txt")).toBeNull();
    expect(resolveRelativePath("", "/root.txt")).toBeNull();
    expect(resolveRelativePath("dir", "C:foo.txt")).toBeNull();
    expect(resolveRelativePath("dir", "c:/foo/bar.txt")).toBeNull();
    expect(resolveRelativePath("dir", "a\\b.txt")).toBeNull();
    expect(resolveRelativePath("dir", "a\0b.txt")).toBeNull();
  });

  it("rejects '..' escaping the repository root or landing on the empty root", () => {
    expect(resolveRelativePath("", "..")).toBeNull();
    expect(resolveRelativePath("a", "../..")).toBeNull();
    expect(resolveRelativePath("a/b", "../../../c.txt")).toBeNull();
    expect(resolveRelativePath("a", "..")).toBeNull();
    expect(resolveRelativePath("a/b", "../..")).toBeNull();
    expect(resolveRelativePath("", "")).toBeNull();
    expect(resolveRelativePath("", ".")).toBeNull();
    expect(resolveRelativePath("", "././.")).toBeNull();
  });

  it("normalizes './', '//' and in-bounds '..' segments", () => {
    expect(resolveRelativePath("", "./a//b/./c.txt")).toBe("a/b/c.txt");
    expect(resolveRelativePath("apps/web", "./reqs//base.txt")).toBe("apps/web/reqs/base.txt");
    expect(resolveRelativePath("apps/web", "../shared/./common.txt")).toBe("apps/shared/common.txt");
    expect(resolveRelativePath("a/b/c", "../../d/e/../f.txt")).toBe("a/d/f.txt");
  });
});

describe("utf8ByteLength", () => {
  it("counts 1-byte, 2-byte, 3-byte and 4-byte surrogate-pair characters", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("ascii")).toBe(5);
    // 2-byte characters (U+0080..U+07FF)
    expect(utf8ByteLength("éü")).toBe(4);
    expect(utf8ByteLength("\u0080\u07ff")).toBe(4);
    // 3-byte characters (U+0800..U+FFFF excluding surrogates)
    expect(utf8ByteLength("€漢")).toBe(6);
    expect(utf8ByteLength("\u0800\uffff")).toBe(6);
    // 4-byte surrogate pairs (U+10000..U+10FFFF)
    expect(utf8ByteLength("🚀🎉")).toBe(8);
    expect(utf8ByteLength("aé€🚀")).toBe(1 + 2 + 3 + 4);
  });

  it("handles unpaired surrogates without throwing", () => {
    // High surrogate (0xD800..0xDBFF) advances i and counts 4 bytes
    expect(utf8ByteLength("\ud800")).toBe(4);
    expect(utf8ByteLength("\udbff")).toBe(4);
    // Unpaired low surrogate (0xDC00..0xDFFF) falls into the 3-byte branch
    expect(utf8ByteLength("\udc00")).toBe(3);
  });
});

describe("workspaceGlobToRegExp and matchesWorkspaceGlobs", () => {
  it("matches '**/' across zero or multiple directories and trailing '/**'", () => {
    const deep = workspaceGlobToRegExp("**/pkg");
    expect(deep.test("pkg")).toBe(true);
    expect(deep.test("a/pkg")).toBe(true);
    expect(deep.test("a/b/c/pkg")).toBe(true);
    expect(deep.test("a/pkg/extra")).toBe(false);

    const mid = workspaceGlobToRegExp("packages/**/app");
    expect(mid.test("packages/app")).toBe(true);
    expect(mid.test("packages/a/app")).toBe(true);
    expect(mid.test("packages/a/b/app")).toBe(true);
    expect(mid.test("other/a/app")).toBe(false);

    const trailing = workspaceGlobToRegExp("packages/**");
    expect(trailing.test("packages/a")).toBe(true);
    expect(trailing.test("packages/a/b/c")).toBe(true);
    expect(trailing.test("packages")).toBe(false);
  });

  it("matches '?' against a single non-slash character and escapes regex metacharacters", () => {
    const single = workspaceGlobToRegExp("pkg-?");
    expect(single.test("pkg-a")).toBe(true);
    expect(single.test("pkg-1")).toBe(true);
    expect(single.test("pkg-")).toBe(false);
    expect(single.test("pkg-ab")).toBe(false);
    expect(single.test("pkg-/")).toBe(false);

    const meta = workspaceGlobToRegExp("./packages/a.b+c(d)[e]{f}^$/");
    expect(meta.test("packages/a.b+c(d)[e]{f}^$")).toBe(true);
    expect(meta.test("packages/axb+c(d)[e]{f}^$")).toBe(false);

    expect(workspaceGlobToRegExp(".").test("")).toBe(true);
    expect(workspaceGlobToRegExp(".").test("a")).toBe(false);
  });

  it("evaluates '!' negations and later re-inclusions in order", () => {
    const globs = ["packages/*", "!packages/internal-*", "packages/internal-public"];
    expect(matchesWorkspaceGlobs("packages/ui", globs)).toBe(true);
    expect(matchesWorkspaceGlobs("packages/internal-secret", globs)).toBe(false);
    expect(matchesWorkspaceGlobs("packages/internal-public", globs)).toBe(true);
    expect(matchesWorkspaceGlobs("apps/web", globs)).toBe(false);
  });

  it("evaluates deeply repeated wildcard globs in linear time without regex backtracking", () => {
    const start = Date.now();
    const deepDir = `${"a/".repeat(24)}a`;
    const deepGlob = `${"**/".repeat(15)}z`;
    expect(matchesWorkspaceGlobs(deepDir, [deepGlob])).toBe(false);
    expect(workspaceGlobToRegExp(deepGlob).test(deepDir)).toBe(false);

    const starDir = "a".repeat(30);
    const starGlob = `${"*a".repeat(15)}*z`;
    expect(matchesWorkspaceGlobs(starDir, [starGlob])).toBe(false);
    expect(workspaceGlobToRegExp(starGlob).test(starDir)).toBe(false);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe("other util helpers", () => {
  it("normalizes PyPI names and manipulates paths", () => {
    expect(normalizePypiName("  Zope.Interface__Foo--Bar ")).toBe("zope-interface-foo-bar");
    expect(dirname("a/b/c.json")).toBe("a/b");
    expect(dirname("c.json")).toBe("");
    expect(basename("a/b/c.json")).toBe("c.json");
    expect(basename("c.json")).toBe("c.json");
    expect(joinPath("", "a", "", "b")).toBe("a/b");
    expect(isWithinDir("a/b", "")).toBe(true);
    expect(isWithinDir("a/b", "a")).toBe(true);
    expect(isWithinDir("a", "a")).toBe(true);
    expect(isWithinDir("ab", "a")).toBe(false);
    expect(relativeTo("a/b", "")).toBe("a/b");
    expect(relativeTo("a", "a")).toBe("");
    expect(relativeTo("a/b/c", "a")).toBe("b/c");
  });

  it("strips BOM, detects line endings and compares values deeply", () => {
    expect(stripBom("\uFEFFhello")).toEqual({ text: "hello", offset: 1 });
    expect(stripBom("hello")).toEqual({ text: "hello", offset: 0 });
    expect(detectLineEnding("a\r\nb\n")).toBe("\r\n");
    expect(detectLineEnding("a\nb\r\n")).toBe("\n");
    expect(detectLineEnding("no newline")).toBe("\n");
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([1])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(deepEqual({ a: [1, Number.NaN, new Date("2026-01-01T00:00:00Z")] }, { a: [1, Number.NaN, new Date("2026-01-01T00:00:00Z")] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
  });
});
