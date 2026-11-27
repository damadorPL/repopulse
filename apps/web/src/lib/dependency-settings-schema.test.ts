import { describe, expect, it } from "vitest";

import { addDependencyProjectsInput, dependencySettingsInput } from "./dependency-settings-schema";

describe("addDependencyProjectsInput", () => {
  it("accepts subscriptions and URLs with defaults", () => {
    const parsed = addDependencyProjectsInput.parse({
      sources: [{ subscriptionId: "s1" }, { repoUrlOrSlug: " vercel/next.js " }],
    });
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
    expect(addDependencyProjectsInput.safeParse({ sources: [{ subscriptionId: "s1" }], extra: true }).success).toBe(
      false,
    );
    expect(
      addDependencyProjectsInput.safeParse({ sources: [{ subscriptionId: "s1", repoUrlOrSlug: "a/b" }] }).success,
    ).toBe(false);
    expect(
      addDependencyProjectsInput.safeParse({ sources: [{ subscriptionId: "s1" }], updateMode: "YOLO" }).success,
    ).toBe(false);
  });
});

describe("dependencySettingsInput", () => {
  it("validates ranges and the scan interval", () => {
    expect(
      dependencySettingsInput.safeParse({
        projectId: "p",
        minReleaseAgeDays: 30,
        maxOpenPrs: 20,
        scanIntervalHours: 168,
      }).success,
    ).toBe(true);
    expect(dependencySettingsInput.safeParse({ projectId: "p", minReleaseAgeDays: 31 }).success).toBe(false);
    expect(dependencySettingsInput.safeParse({ projectId: "p", maxOpenPrs: 0 }).success).toBe(false);
    expect(dependencySettingsInput.safeParse({ projectId: "p", scanIntervalHours: 7 }).success).toBe(false);
    expect(dependencySettingsInput.safeParse({ projectId: "p", commitPrefix: "a\nb" }).success).toBe(false);
    expect(dependencySettingsInput.safeParse({ projectId: "p", userId: "u2" }).success).toBe(false);
  });
});
