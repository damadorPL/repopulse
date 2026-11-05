import { describe, expect, it } from "vitest";
import {
  comparePep440,
  formatPep440,
  isPep440Prerelease,
  normalizePep440,
  parsePep440,
  parsePep440Constraint,
  pep440BumpSpecifier,
  pep440LowerBound,
  pep440MaxSatisfying,
  pep440Satisfies,
} from "./pep440.js";

describe("parsePep440", () => {
  it("parses every part", () => {
    expect(parsePep440("1!2.3.4rc5.post6.dev7+ubuntu.1")).toEqual({
      epoch: 1,
      release: [2, 3, 4],
      pre: { label: "rc", number: 5 },
      post: 6,
      dev: 7,
      local: ["ubuntu", 1],
    });
  });

  it("normalizes alternative spellings", () => {
    expect(normalizePep440("1.0-alpha1")).toBe("1.0a1");
    expect(normalizePep440("1.0.BETA.2")).toBe("1.0b2");
    expect(normalizePep440("1.0c1")).toBe("1.0rc1");
    expect(normalizePep440("1.0preview3")).toBe("1.0rc3");
    expect(normalizePep440("1.0-1")).toBe("1.0.post1");
    expect(normalizePep440("1.0.rev")).toBe("1.0.post0");
    expect(normalizePep440("v2.1")).toBe("2.1");
    expect(normalizePep440("1.0.dev")).toBe("1.0.dev0");
    expect(normalizePep440("1.0+Local_A-1")).toBe("1.0+local.a.1");
  });

  it("rejects invalid versions", () => {
    expect(parsePep440("")).toBeNull();
    expect(parsePep440("latest")).toBeNull();
    expect(parsePep440("1.0.0-beta+")).toBeNull();
    expect(parsePep440("1..0")).toBeNull();
  });

  it("formats round trip", () => {
    expect(formatPep440(parsePep440("2!1.0a1.post2.dev3+abc.5")!)).toBe("2!1.0a1.post2.dev3+abc.5");
  });

  it("detects pre-releases (pre and dev)", () => {
    expect(isPep440Prerelease("1.0a1")).toBe(true);
    expect(isPep440Prerelease("1.0.dev1")).toBe(true);
    expect(isPep440Prerelease("1.0.post1")).toBe(false);
    expect(isPep440Prerelease("1.0")).toBe(false);
  });
});

describe("comparePep440", () => {
  it("orders per PEP 440", () => {
    const ordered = [
      "1.0.dev456",
      "1.0a1",
      "1.0a2.dev456",
      "1.0a12.dev456",
      "1.0a12",
      "1.0b1.dev456",
      "1.0b2",
      "1.0b2.post345.dev456",
      "1.0b2.post345",
      "1.0rc1.dev456",
      "1.0rc1",
      "1.0",
      "1.0+abc.5",
      "1.0+abc.7",
      "1.0+5",
      "1.0.post456.dev34",
      "1.0.post456",
      "1.0.15",
      "1.1.dev1",
      "1!0.1",
    ];
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort(comparePep440)).toEqual(ordered);
  });

  it("ignores trailing zeros and compares local version segments per PEP 440", () => {
    expect(comparePep440("1.0", "1.0.0")).toBe(0);
    expect(comparePep440("1.2", "1.10")).toBe(-1);
    expect(comparePep440("1.0+1", "1.0+a")).toBe(1);
    expect(comparePep440("1.0+a", "1.0+1")).toBe(-1);
    expect(comparePep440("1.0+abc", "1.0+abc.0")).toBe(-1);
    expect(comparePep440("1.0+abc.1", "1.0+abc")).toBe(1);
    expect(comparePep440("1.0+abc", "1.0+abd")).toBe(-1);
  });
});

describe("pep440Satisfies", () => {
  const cases: Array<[string, string, boolean]> = [
    ["1.4.5", "~=1.4.2", true],
    ["1.5.0", "~=1.4.2", false],
    ["1.9", "~=1.4", true],
    ["2.0", "~=1.4", false],
    ["2.0", "==2", true],
    ["1.4.5", "==1.4.*", true],
    ["1.5", "==1.4.*", false],
    ["1.4.5", "!=1.4.*", false],
    ["1.0+local", "==1.0", true],
    ["1.0+local", "==1.0+other", false],
    ["1.0", "===1.0", true],
    ["1.0.0", "===1.0", false],
    ["2.0", ">=1.2,<2", false],
    ["1.9.9", ">=1.2, <2", true],
    ["2.0rc1", "<2", false],
    ["2.0rc1", "<2.0rc2", true],
    ["1.7.1", ">1.7", true],
    ["1.7.0.post1", ">1.7", false],
    ["1.7.post2", ">1.7.post1", true],
    ["1.7+local", ">1.7", false],
    ["1.7", "<=1.7", true],
    ["1.7+local", "<=1.7", true],
    ["1!1.0", ">=2.0", true],
    ["3.0", "", true],
  ];
  for (const [version, spec, expected] of cases) {
    it(`${version} ${expected ? "satisfies" : "does not satisfy"} "${spec}"`, () => {
      expect(pep440Satisfies(version, spec)).toBe(expected);
    });
  }

  it("handles Poetry carets and tildes", () => {
    expect(pep440Satisfies("1.9.0", "^1.2.3", "poetry")).toBe(true);
    expect(pep440Satisfies("2.0.0", "^1.2.3", "poetry")).toBe(false);
    expect(pep440Satisfies("0.2.9", "^0.2.3", "poetry")).toBe(true);
    expect(pep440Satisfies("0.3.0", "^0.2.3", "poetry")).toBe(false);
    expect(pep440Satisfies("0.0.4", "^0.0.3", "poetry")).toBe(false);
    expect(pep440Satisfies("0.9", "^0", "poetry")).toBe(true);
    expect(pep440Satisfies("1.0", "^0", "poetry")).toBe(false);
    expect(pep440Satisfies("1.2.9", "~1.2.3", "poetry")).toBe(true);
    expect(pep440Satisfies("1.3.0", "~1.2.3", "poetry")).toBe(false);
    expect(pep440Satisfies("1.9", "~1", "poetry")).toBe(true);
    expect(pep440Satisfies("1.2.3", "1.2.3", "poetry")).toBe(true);
    expect(pep440Satisfies("1.2.4", "1.2.*", "poetry")).toBe(true);
    expect(pep440Satisfies("9.0", "*", "poetry")).toBe(true);
    expect(pep440Satisfies("3.1", ">=1,<2 || ^3", "poetry")).toBe(true);
    expect(pep440Satisfies("2.5", ">=1,<2 || ^3", "poetry")).toBe(false);
    expect(pep440Satisfies("1.4", ">=1.2 <1.5", "poetry")).toBe(true);
  });

  it("rejects Poetry syntax in PEP 440 mode", () => {
    expect(parsePep440Constraint("^1.2")).toBeNull();
    expect(parsePep440Constraint("1.2")).toBeNull();
    expect(parsePep440Constraint(">=1 || <3")).toBeNull();
    expect(parsePep440Constraint("~=1")).toBeNull();
    expect(parsePep440Constraint(">=1.0,")).toBeNull();
    expect(parsePep440Constraint(">=1.*")).toBeNull();
  });
});

describe("pep440MaxSatisfying / pep440LowerBound", () => {
  it("finds the newest match", () => {
    expect(pep440MaxSatisfying(["1.0", "1.4", "2.0", "1.9.1"], ">=1.2,<2")).toBe("1.9.1");
    expect(pep440MaxSatisfying(["1.0"], ">=2")).toBeNull();
  });

  it("finds the lower bound", () => {
    expect(pep440LowerBound(">=1.2,<2")).toBe("1.2");
    expect(pep440LowerBound("==4.1.0")).toBe("4.1.0");
    expect(pep440LowerBound("~=1.4.2")).toBe("1.4.2");
    expect(pep440LowerBound("^0.3", "poetry")).toBe("0.3");
    expect(pep440LowerBound("<2")).toBeNull();
    expect(pep440LowerBound("")).toBeNull();
    expect(pep440LowerBound(">=1,<2 || >=3", "poetry")).toBe("1");
  });
});

describe("pep440BumpSpecifier", () => {
  const cases: Array<[string, string, "pep440" | "poetry", string | "unchanged" | "blocked"]> = [
    ["==1.2.3", "1.4.0", "pep440", "==1.4.0"],
    ["==1.2.3", "2024.1", "pep440", "==2024.1"],
    ["~=1.2", "1.4.0", "pep440", "~=1.4"],
    ["~=1.2.0", "1.4.1", "pep440", "~=1.4.1"],
    [">=1.2", "1.4.0", "pep440", ">=1.4"],
    [">=1.2.3", "2.0", "pep440", ">=2.0.0"],
    [">= 1.2, < 2", "1.9.0", "pep440", ">= 1.9, < 2"],
    [">=1.2,<2", "2.0.0", "pep440", "blocked"],
    ["==1.*", "2.3.0", "pep440", "==2.*"],
    ["==1.4.*", "1.4.9", "pep440", "unchanged"],
    ["<3", "2.5", "pep440", "unchanged"],
    ["<2", "2.5", "pep440", "blocked"],
    [">=1.0,!=1.5", "1.5", "pep440", "blocked"],
    ["", "1.0", "pep440", "unchanged"],
    ["^1.2", "1.4.0", "poetry", "^1.4"],
    ["^1.2.3", "2.0.0", "poetry", "^2.0.0"],
    ["~1.2.3", "1.4.0", "poetry", "~1.4.0"],
    ["1.2.3", "1.4.0", "poetry", "1.4.0"],
    ["*", "3.0", "poetry", "unchanged"],
    [">=1,<2 || ^3", "3.5", "poetry", "unchanged"],
    [">=1,<2 || ^3", "4.0", "poetry", "blocked"],
    ["==1.0", "2.0rc1", "pep440", "==2.0rc1"],
    [">=1!1.2", "1!1.4.0", "pep440", ">=1!1.4"],
    ["==1!1.*", "1!2.0.0", "pep440", "==1!2.*"],
  ];
  for (const [declared, target, syntax, expected] of cases) {
    it(`${syntax} "${declared}" + ${target} → ${expected}`, () => {
      const result = pep440BumpSpecifier(declared, target, syntax);
      if (expected === "unchanged" || expected === "blocked") expect(result).toEqual({ outcome: expected });
      else expect(result).toEqual({ outcome: "bumped", declared: expected });
    });
  }
});
