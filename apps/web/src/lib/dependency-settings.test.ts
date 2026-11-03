import { describe, expect, it } from "vitest";
import {
  addDependencyProjectsInput,
  changelogUrl,
  dependencySettingsInput,
  formatOutdatedCounts,
  githubRepoFromUrl,
  readIgnoreRules,
  registryUrl,
  sameIgnoreRule,
  statusExplanation,
} from "./dependency-settings";

describe("addDependencyProjectsInput", () => {
  it("accepts subscriptions and URLs with defaults", () => {
    const parsed = addDependencyProjectsInput.parse({ sources: [{ subscriptionId: "s1" }, { repoUrlOrSlug: " vercel/next.js " }] });
    expect(parsed).toEqual({
      sources: [{ subscriptionId: "s1" }, { repoUrlOrSlug: "vercel/next.js" }],
      updateMode: "NOTIFY",
      notifyOnFirstScan: false,
    });
  });

  it("rejects empty, too many, unknown keys and mixed sources", () => {
    expect(addDependencyProjectsInput.safeParse({ sources: [] }).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => ({ subscriptionId: `s${i}` }));
    expect(addDependencyProjectsInput.safeParse({ sources: many }).success).toBe(false);
    expect(addDependencyProjectsInput.safeParse({ sources: [{ subscriptionId: "s1" }], extra: true }).success).toBe(false);
    expect(addDependencyProjectsInput.safeParse({ sources: [{ subscriptionId: "s1", repoUrlOrSlug: "a/b" }] }).success).toBe(false);
    expect(addDependencyProjectsInput.safeParse({ sources: [{ subscriptionId: "s1" }], updateMode: "YOLO" }).success).toBe(false);
  });
});

describe("dependencySettingsInput", () => {
  it("validates ranges and the scan interval", () => {
    expect(dependencySettingsInput.safeParse({ projectId: "p", minReleaseAgeDays: 30, maxOpenPrs: 20, scanIntervalHours: 168 }).success).toBe(true);
    expect(dependencySettingsInput.safeParse({ projectId: "p", minReleaseAgeDays: 31 }).success).toBe(false);
    expect(dependencySettingsInput.safeParse({ projectId: "p", maxOpenPrs: 0 }).success).toBe(false);
    expect(dependencySettingsInput.safeParse({ projectId: "p", scanIntervalHours: 7 }).success).toBe(false);
    expect(dependencySettingsInput.safeParse({ projectId: "p", commitPrefix: "a\nb" }).success).toBe(false);
    expect(dependencySettingsInput.safeParse({ projectId: "p", userId: "u2" }).success).toBe(false);
  });
});

describe("ignore rules helpers", () => {
  it("reads stored JSON defensively", () => {
    expect(readIgnoreRules([{ name: "react" }, { name: "vue", versions: ">=3" }, { name: "" }, 3, null, { versions: "1" }])).toEqual([
      { name: "react" },
      { name: "vue", versions: ">=3" },
    ]);
    expect(readIgnoreRules("nope")).toEqual([]);
  });

  it("compares rules by name (case-insensitive) and range", () => {
    expect(sameIgnoreRule({ name: "React" }, { name: "react" })).toBe(true);
    expect(sameIgnoreRule({ name: "react", versions: "18" }, { name: "react" })).toBe(false);
    expect(sameIgnoreRule({ name: "react", versions: "" }, { name: "react" })).toBe(true);
  });
});

describe("display helpers", () => {
  it("formats outdated counts", () => {
    expect(formatOutdatedCounts({ major: 3, minor: 5, patch: 2, other: 0 })).toBe("3 major · 5 minor · 2 patch");
    expect(formatOutdatedCounts({ major: 0, minor: 0, patch: 0, other: 0 })).toBe("");
  });

  it("explains statuses", () => {
    const base = { wantedVersion: null };
    expect(statusExplanation({ ...base, status: "OUTDATED", targetVersion: "1.4.0", latestVersion: "2.0.0" }, 3)).toBe(
      "2.0.0 available, outside your policy",
    );
    expect(statusExplanation({ ...base, status: "OUTDATED", targetVersion: "2.0.0", latestVersion: "2.0.0" }, 3)).toBeNull();
    expect(statusExplanation({ ...base, status: "TOO_NEW", targetVersion: null, latestVersion: "1.1.0" }, 1)).toBe("1.1.0 is younger than 1 day");
  });

  it("builds registry and changelog links", () => {
    expect(registryUrl("NPM", "@types/node")).toBe("https://www.npmjs.com/package/%40types/node");
    expect(registryUrl("PYPI", "django")).toBe("https://pypi.org/project/django/");
    expect(githubRepoFromUrl("https://github.com/facebook/react.git")).toEqual({ owner: "facebook", name: "react", fullName: "facebook/react" });
    expect(githubRepoFromUrl("https://gitlab.com/a/b")).toBeNull();
    expect(githubRepoFromUrl("javascript:alert(1)")).toBeNull();
    expect(changelogUrl("https://github.com/vercel/next.js")).toBe("https://github.com/vercel/next.js/releases");
    expect(changelogUrl(null)).toBeNull();
  });
});
