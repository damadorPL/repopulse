import { describe, expect, it } from "vitest";
import { npmBumpRange, npmLowerBound, npmMaxSatisfying, npmSatisfies, npmUnsupportedReason } from "./npm.js";

describe("npmUnsupportedReason", () => {
  it("accepts semver ranges", () => {
    for (const spec of ["1.2.3", "^1.2.3", "~1.2", ">=1 <3", "1.x", "1 || 2", "1.2.3 - 2.0.0", "=1.0.0"]) {
      expect(npmUnsupportedReason(spec), spec).toBeNull();
    }
  });

  it("rejects non-registry specs", () => {
    for (const spec of [
      "workspace:*",
      "catalog:",
      "npm:react@18",
      "file:../x",
      "link:../x",
      "git+https://github.com/a/b.git",
      "github:a/b",
      "a/b",
      "https://example.com/x.tgz",
      "*",
      "",
      "latest",
      "next",
    ]) {
      expect(npmUnsupportedReason(spec), spec).not.toBeNull();
    }
  });
});

describe("npm ranges", () => {
  it("maxSatisfying and lower bound", () => {
    expect(npmMaxSatisfying(["1.2.3", "1.4.0", "2.0.0"], "^1.2.3")).toBe("1.4.0");
    expect(npmLowerBound("^1.2.3")).toBe("1.2.3");
    expect(npmLowerBound("1.x")).toBe("1.0.0");
    expect(npmSatisfies("2.0.0-rc.1", "^2.0.0-rc.0")).toBe(true);
    expect(npmSatisfies("x", "^1")).toBe(false);
  });
});

describe("npmBumpRange", () => {
  const cases: Array<[string, string, string | "unchanged" | "blocked"]> = [
    ["1.2.3", "1.4.0", "1.4.0"],
    ["^1.2.3", "1.4.0", "^1.4.0"],
    ["~1.2.3", "1.2.9", "~1.2.9"],
    [">=1.2.3", "1.4.0", ">=1.4.0"],
    ["1.x", "2.1.0", "2.x"],
    ["^1", "2.1.0", "^2"],
    ["^1", "1.4.0", "unchanged"],
    ["1.2.x", "1.4.0", "1.4.x"],
    ["^1.2", "1.4.5", "^1.4"],
    ["=1.2.3", "1.4.0", "=1.4.0"],
    ["v1.2.3", "1.4.0", "v1.4.0"],
    ["^1.2.3", "2.0.0-rc.1", "^2.0.0-rc.1"],
    [">=1 <3", "2.5.0", "unchanged"],
    [">=1 <3", "3.0.0", "blocked"],
    ["1 || 2", "3.0.0", "blocked"],
    ["<3", "2.0.0", "unchanged"],
    [">1.2.3", "1.4.0", "unchanged"],
  ];
  for (const [declared, target, expected] of cases) {
    it(`"${declared}" + ${target} → ${expected}`, () => {
      const result = npmBumpRange(declared, target);
      if (expected === "unchanged" || expected === "blocked") expect(result).toEqual({ outcome: expected });
      else expect(result).toEqual({ outcome: "bumped", declared: expected });
    });
  }
});
