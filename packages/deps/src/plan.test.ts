import { describe, expect, it } from "vitest";
import {
  applyPolicy,
  classifyUpdate,
  groupCapability,
  groupUpdates,
  ignorePatternMatches,
  ignoreRulesSchema,
  isValidGroupKey,
  isValidIgnorePattern,
  requiresPythonOverlaps,
  selectTarget,
  slugifyGroupName,
  type DepsPolicy,
  type PlanDependency,
} from "./plan.js";
import type { RegistryVersion } from "./registries/types.js";

const NOW = new Date("2026-11-03T12:00:00Z");
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

function v(version: string, ageDays = 30, extra: Partial<RegistryVersion> = {}): RegistryVersion {
  return { version, publishedAt: daysAgo(ageDays), deprecated: false, yanked: false, requiresPython: null, sha256: [], ...extra };
}

const POLICY: DepsPolicy = {
  maxUpdateLevel: "MINOR",
  includePrereleases: false,
  minReleaseAgeDays: 3,
  rangeStrategy: "BUMP",
  ignoreRules: [],
};

const npmDep = (declared: string, currentVersion: string | null, extra: Partial<PlanDependency> = {}): PlanDependency => ({
  ecosystem: "NPM",
  name: "react",
  kind: "PROD",
  declared,
  rangeSyntax: "npm",
  currentVersion,
  supported: true,
  ...extra,
});

describe("classifyUpdate", () => {
  it("matches classifySemver thresholds", () => {
    expect(classifyUpdate("1.2.3", "2.0.0", "NPM")).toBe("MAJOR");
    expect(classifyUpdate("0.2.3", "0.3.0", "NPM")).toBe("MAJOR");
    expect(classifyUpdate("1.2.3", "1.3.0", "NPM")).toBe("MINOR");
    expect(classifyUpdate("1.2.3", "1.2.4", "NPM")).toBe("PATCH");
    expect(classifyUpdate("0.0.3", "0.0.4", "NPM")).toBe("PATCH");
    expect(classifyUpdate("1.2.3", "2.0.0-rc.1", "NPM")).toBe("PRERELEASE");
    expect(classifyUpdate("1.2", "1.2.0.1", "PYPI")).toBe("PATCH");
    expect(classifyUpdate("1.2", "1.2.post1", "PYPI")).toBe("PATCH");
    expect(classifyUpdate("2024.1", "2025.1", "PYPI")).toBe("MAJOR");
    expect(classifyUpdate("1.0", "1.0.0", "PYPI")).toBe("OTHER");
  });
});

describe("selectTarget", () => {
  it("targets the newest minor while showing the major as latest (maxUpdateLevel = MINOR)", () => {
    const result = selectTarget([v("18.2.0"), v("18.3.1"), v("19.0.0")], npmDep("^18.2.0", "18.2.0"), POLICY, NOW);
    expect(result).toMatchObject({
      status: "OUTDATED",
      currentVersion: "18.2.0",
      currentFromLockfile: true,
      targetVersion: "18.3.1",
      latestVersion: "19.0.0",
      wantedVersion: "18.3.1",
      level: "MINOR",
      newDeclared: "^18.3.1",
    });
  });

  it("ABOVE_LEVEL when only majors exist", () => {
    const result = selectTarget([v("18.2.0"), v("19.0.0")], npmDep("^18.2.0", "18.2.0"), POLICY, NOW);
    expect(result).toMatchObject({ status: "ABOVE_LEVEL", targetVersion: null, consideredVersion: "19.0.0", level: "MAJOR" });
  });

  it("TOO_NEW for a 1-day-old release with minReleaseAgeDays = 3, falls back to an older one", () => {
    const tooNew = selectTarget([v("1.0.0"), v("1.1.0", 1)], npmDep("^1.0.0", "1.0.0"), POLICY, NOW);
    expect(tooNew).toMatchObject({ status: "TOO_NEW", consideredVersion: "1.1.0", targetVersion: null });
    const fallback = selectTarget([v("1.0.0"), v("1.0.5", 10), v("1.1.0", 1)], npmDep("^1.0.0", "1.0.0"), POLICY, NOW);
    expect(fallback).toMatchObject({ status: "OUTDATED", targetVersion: "1.0.5" });
    expect(fallback.targetReleasedAt).toEqual(daysAgo(10));
  });

  it("never targets deprecated or yanked versions", () => {
    const result = selectTarget(
      [v("1.0.0"), v("1.1.0"), v("1.2.0", 30, { deprecated: true }), v("1.3.0", 30, { yanked: true })],
      npmDep("^1.0.0", "1.0.0"),
      POLICY,
      NOW,
    );
    expect(result).toMatchObject({ status: "OUTDATED", targetVersion: "1.1.0", latestVersion: "1.1.0" });
  });

  it("UP_TO_DATE when nothing newer passes", () => {
    expect(selectTarget([v("1.0.0")], npmDep("^1.0.0", "1.0.0"), POLICY, NOW).status).toBe("UP_TO_DATE");
    expect(selectTarget([v("1.0.0"), v("2.0.0-rc.1")], npmDep("^1.0.0", "1.0.0"), { ...POLICY, maxUpdateLevel: "MAJOR" }, NOW).status).toBe(
      "UP_TO_DATE",
    );
  });

  it("allows pre-releases of the same line only when opted in and current is a pre-release", () => {
    const candidates = [v("2.0.0-rc.1"), v("2.0.0-rc.2"), v("2.1.0-alpha.1")];
    const dep = npmDep("^2.0.0-rc.1", "2.0.0-rc.1");
    expect(selectTarget(candidates, dep, { ...POLICY, includePrereleases: true }, NOW)).toMatchObject({
      status: "OUTDATED",
      targetVersion: "2.0.0-rc.2",
      level: "PRERELEASE",
    });
    expect(selectTarget(candidates, dep, POLICY, NOW).status).toBe("UP_TO_DATE");
  });

  it("applies ignore rules (whole dependency or version ranges)", () => {
    const candidates = [v("1.0.0"), v("1.1.0"), v("1.2.0")];
    expect(selectTarget(candidates, npmDep("^1.0.0", "1.0.0"), { ...POLICY, ignoreRules: [{ name: "re*" }] }, NOW).status).toBe("IGNORED");
    expect(
      selectTarget(candidates, npmDep("^1.0.0", "1.0.0"), { ...POLICY, ignoreRules: [{ name: "react", versions: ">=1.2.0" }] }, NOW),
    ).toMatchObject({ status: "OUTDATED", targetVersion: "1.1.0" });
  });

  it("LOCKFILE_ONLY: in range → OUTDATED with the declared spec kept; otherwise BLOCKED_BY_RANGE", () => {
    const policy: DepsPolicy = { ...POLICY, rangeStrategy: "LOCKFILE_ONLY" };
    expect(selectTarget([v("1.2.0"), v("1.3.0")], npmDep("^1.2.0", "1.2.0"), policy, NOW)).toMatchObject({
      status: "OUTDATED",
      targetVersion: "1.3.0",
      newDeclared: "^1.2.0",
    });
    expect(selectTarget([v("1.2.0"), v("1.3.0")], npmDep("~1.2.0", "1.2.0"), policy, NOW)).toMatchObject({
      status: "BLOCKED_BY_RANGE",
      consideredVersion: "1.3.0",
    });
    // Falls back to the newest version the range admits.
    expect(selectTarget([v("1.2.0"), v("1.2.4"), v("1.3.0")], npmDep("~1.2.0", "1.2.0"), policy, NOW)).toMatchObject({
      status: "OUTDATED",
      targetVersion: "1.2.4",
    });
  });

  it("BUMP: an upper bound that excludes the target blocks it", () => {
    const dep: PlanDependency = { ...npmDep(">=1.2,<1.3", "1.2"), ecosystem: "PYPI", name: "foo", rangeSyntax: "pep440" };
    expect(selectTarget([v("1.2"), v("1.3")], dep, POLICY, NOW)).toMatchObject({ status: "BLOCKED_BY_RANGE", consideredVersion: "1.3" });
    expect(selectTarget([v("1.2"), v("1.2.5"), v("1.3")], dep, POLICY, NOW)).toMatchObject({
      status: "OUTDATED",
      targetVersion: "1.2.5",
      newDeclared: ">=1.2,<1.3", // precision kept: 1.2.5 → "1.2"
    });
  });

  it("peer dependencies are never bumped beyond the declared range", () => {
    const result = selectTarget([v("17.0.0"), v("17.5.0"), v("18.0.0")], npmDep(">=17 <18", null, { kind: "PEER" }), { ...POLICY, maxUpdateLevel: "MAJOR" }, NOW);
    expect(result).toMatchObject({ status: "OUTDATED", targetVersion: "17.5.0", newDeclared: ">=17 <18", currentFromLockfile: false, currentVersion: "17.0.0" });
  });

  it("DISMISSED for the same version, OUTDATED again for a newer one", () => {
    const dep = npmDep("^1.0.0", "1.0.0", { dismissedVersion: "1.1.0" });
    expect(selectTarget([v("1.0.0"), v("1.1.0")], dep, POLICY, NOW)).toMatchObject({ status: "DISMISSED", targetVersion: "1.1.0" });
    expect(selectTarget([v("1.0.0"), v("1.1.0"), v("1.2.0")], dep, POLICY, NOW)).toMatchObject({ status: "OUTDATED", targetVersion: "1.2.0" });
  });

  it("filters by requires-python", () => {
    const dep: PlanDependency = { ecosystem: "PYPI", name: "lib", kind: "PROD", declared: "==1.0", rangeSyntax: "pep440", currentVersion: "1.0", supported: true };
    const candidates = [v("1.0"), v("1.1", 30, { requiresPython: [">=3.8"] }), v("1.2", 30, { requiresPython: [">=3.13"] })];
    expect(selectTarget(candidates, dep, { ...POLICY, requiresPython: ">=3.9,<3.12" }, NOW)).toMatchObject({
      status: "OUTDATED",
      targetVersion: "1.1",
      newDeclared: "==1.1",
      latestVersion: "1.1",
    });
    expect(requiresPythonOverlaps(">=3.8", "^3.11", "poetry")).toBe(true);
    expect(requiresPythonOverlaps("<3", ">=3.9")).toBe(false);
  });

  it("uses the declared lower bound without a lockfile and handles Poetry syntax", () => {
    const dep: PlanDependency = { ecosystem: "PYPI", name: "django", kind: "PROD", declared: "^4.2", rangeSyntax: "poetry", currentVersion: null, supported: true };
    expect(selectTarget([v("4.2"), v("4.2.7"), v("5.0")], dep, POLICY, NOW)).toMatchObject({
      status: "OUTDATED",
      currentVersion: "4.2",
      targetVersion: "4.2.7",
      newDeclared: "^4.2",
      level: "PATCH",
    });
  });

  it("UNSUPPORTED_SOURCE for unsupported specs and registry misses", () => {
    expect(selectTarget([], npmDep("workspace:*", null, { supported: false, unsupportedReason: "Workspace dependency" }), POLICY, NOW)).toMatchObject({
      status: "UNSUPPORTED_SOURCE",
      reason: "Workspace dependency",
    });
    const [missing] = applyPolicy([{ dependency: npmDep("^1.0.0", "1.0.0"), candidates: null }], POLICY, NOW);
    expect(missing).toMatchObject({ status: "UNSUPPORTED_SOURCE", reason: "Not on the public registry" });
  });

  it("handles current === null (no lower bound) and publishedAt: null with minReleaseAgeDays > 0", () => {
    const noCurrent = selectTarget(
      [v("1.0.0"), v("1.5.0")],
      { ...npmDep("<2.0", null), ecosystem: "PYPI", rangeSyntax: "pep440" },
      POLICY,
      NOW,
    );
    expect(noCurrent).toMatchObject({
      status: "UP_TO_DATE",
      currentVersion: null,
      latestVersion: "1.5.0",
      reason: "No current version (no lockfile entry or lower bound)",
    });

    const nullPublished = selectTarget(
      [v("1.0.0"), v("1.1.0", 0, { publishedAt: null })],
      npmDep("^1.0.0", "1.0.0"),
      { ...POLICY, minReleaseAgeDays: 7 },
      NOW,
    );
    expect(nullPublished).toMatchObject({
      status: "OUTDATED",
      targetVersion: "1.1.0",
      targetReleasedAt: null,
    });
  });
});

describe("ignore rules", () => {
  it("validates patterns", () => {
    for (const ok of ["react", "@types/*", "*-plugin", "*eslint*", "*", "zope.interface"]) expect(isValidIgnorePattern(ok), ok).toBe(true);
    for (const bad of ["", "re*ct", "**", "a b", "@types/**x"]) expect(isValidIgnorePattern(bad), bad).toBe(false);
  });

  it("matches globs (PyPI names normalized)", () => {
    expect(ignorePatternMatches("@types/*", "@types/node", "NPM")).toBe(true);
    expect(ignorePatternMatches("*-plugin", "eslint-plugin", "NPM")).toBe(true);
    expect(ignorePatternMatches("*eslint*", "typescript-eslint-parser", "NPM")).toBe(true);
    expect(ignorePatternMatches("react", "react-dom", "NPM")).toBe(false);
    expect(ignorePatternMatches("Zope.Interface", "zope-interface", "PYPI")).toBe(true);
    expect(ignorePatternMatches("django*", "Django_Rest", "PYPI")).toBe(true);
  });

  it("zod schema accepts valid rules and rejects bad ones", () => {
    expect(ignoreRulesSchema.parse([{ name: "react", versions: ">=19" }, { name: "django", versions: "" }])).toEqual([
      { name: "react", versions: ">=19" },
      { name: "django" },
    ]);
    expect(ignoreRulesSchema.safeParse([{ name: "re*ct" }]).success).toBe(false);
    expect(ignoreRulesSchema.safeParse([{ name: "a", versions: "not a range" }]).success).toBe(false);
    expect(ignoreRulesSchema.safeParse([{ name: "a", extra: 1 }]).success).toBe(false);
    expect(ignoreRulesSchema.safeParse(Array.from({ length: 51 }, () => ({ name: "a" }))).success).toBe(false);
  });
});

describe("groupUpdates", () => {
  const updates = [
    { ecosystem: "NPM" as const, name: "react", manifestPath: "apps/web/package.json", level: "MAJOR" as const },
    { ecosystem: "NPM" as const, name: "react", manifestPath: "package.json", level: "MAJOR" as const },
    { ecosystem: "NPM" as const, name: "@types/node", manifestPath: "package.json", level: "MINOR" as const },
    { ecosystem: "PYPI" as const, name: "django", manifestPath: "requirements.txt", level: "PATCH" as const },
    { ecosystem: "NPM" as const, name: "axios", manifestPath: "package.json", level: "MAJOR" as const },
  ];

  it("SINGLE", () => {
    const groups = groupUpdates(updates, "SINGLE");
    expect(groups.map((g) => [g.groupKey, g.updates.length])).toEqual([["all", 5]]);
    expect(groups[0]!.updates.map((u) => u.name)).toEqual(["@types/node", "axios", "django", "react", "react"]);
  });

  it("SEPARATE_MAJORS with majors last and PR slots", () => {
    const groups = groupUpdates(updates, "SEPARATE_MAJORS", 2);
    expect(groups.map((g) => [g.groupKey, g.updates.length, g.isMajor, g.hasPrSlot])).toEqual([
      ["all", 2, false, true],
      ["major-axios", 1, true, true],
      ["major-react", 2, true, false],
    ]);
  });

  it("PER_DEPENDENCY", () => {
    const groups = groupUpdates(updates, "PER_DEPENDENCY");
    expect(groups.map((g) => g.groupKey)).toEqual(["npm-types-node", "pypi-django", "npm-axios", "npm-react"]);
  });

  it("slugifies and validates group keys at boundaries", () => {
    expect(slugifyGroupName("@types/node")).toBe("types-node");
    expect(slugifyGroupName("Zope.Interface")).toBe("zope-interface");
    expect(slugifyGroupName("@@@")).toBe("dep");
    expect(slugifyGroupName("a".repeat(100))).toHaveLength(60);

    expect(isValidGroupKey("a")).toBe(true);
    expect(isValidGroupKey("9")).toBe(true);
    expect(isValidGroupKey("a".repeat(80))).toBe(true);
    expect(isValidGroupKey("a".repeat(81))).toBe(false);
    expect(isValidGroupKey("")).toBe(false);
    expect(isValidGroupKey("-a")).toBe(false);
    expect(isValidGroupKey("a-")).toBe(false);
    expect(isValidGroupKey("A")).toBe(false);
    expect(isValidGroupKey("a/b")).toBe(false);
  });
});

describe("groupCapability", () => {
  it("allows manifest-only updates", () => {
    expect(
      groupCapability([{ path: "requirements.txt", packageManager: "PIP", lockfilePath: null }], { lockfileRegeneration: false }),
    ).toEqual({ canCreatePr: true, needsLockfile: false, lockfiles: [], reason: null });
  });

  it("needs the sandbox for lockfiles", () => {
    const manifests = [
      { path: "apps/web/package.json", packageManager: "PNPM" as const, lockfilePath: "pnpm-lock.yaml" },
      { path: "package.json", packageManager: "PNPM" as const, lockfilePath: "pnpm-lock.yaml" },
    ];
    expect(groupCapability(manifests, { lockfileRegeneration: false })).toMatchObject({
      canCreatePr: false,
      needsLockfile: true,
      lockfiles: ["pnpm-lock.yaml"],
    });
    expect(groupCapability(manifests, { lockfileRegeneration: true })).toMatchObject({ canCreatePr: true, needsLockfile: true });
  });

  it("is check only for Yarn, bun.lockb and pip-tools", () => {
    for (const manifest of [
      { path: "package.json", packageManager: "YARN" as const, lockfilePath: "yarn.lock" },
      { path: "package.json", packageManager: "BUN" as const, lockfilePath: "bun.lockb" },
      { path: "requirements.in", packageManager: "PIP_TOOLS" as const, lockfilePath: "requirements.txt" },
    ]) {
      const capability = groupCapability([manifest], { lockfileRegeneration: true });
      expect(capability.canCreatePr, manifest.packageManager).toBe(false);
      expect(capability.reason).toMatch(/check only|binary/);
    }
  });
});
