import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BackfillSettingsForm } from "./backfill-settings-form";
import type { BackfillSettingView, ReapplyCandidate } from "@/server/backfill-settings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/server/actions/backfill-settings", () => ({
  reapplyBackfillSettingsAction: vi.fn(),
  saveBackfillSettingsAction: vi.fn(),
}));

const mockSettings: BackfillSettingView[] = [
  { key: "defaultTarget", value: 100, override: null, fallback: 100, fallbackSource: "default", source: "default", envVar: "RELEASE_BACKFILL_DEFAULT_TARGET", min: 0, max: 1000 },
  { key: "maxAgeDays", value: 0, override: null, fallback: 0, fallbackSource: "default", source: "default", envVar: "RELEASE_BACKFILL_MAX_AGE_DAYS", min: 0, max: 3650 },
  { key: "deepStep", value: 50, override: null, fallback: 50, fallbackSource: "default", source: "default", envVar: null, min: 1, max: 500 },
  { key: "deepCooldownMinutes", value: 1, override: null, fallback: 1, fallbackSource: "default", source: "default", envVar: null, min: 0, max: 1440 },
  { key: "hardCap", value: 1000, override: null, fallback: 1000, fallbackSource: "default", source: "default", envVar: "RELEASE_BACKFILL_HARD_CAP", min: 1, max: 10000 },
  { key: "minQuota", value: 500, override: null, fallback: 500, fallbackSource: "default", source: "default", envVar: "RELEASE_BACKFILL_MIN_QUOTA", min: 0, max: 15000 },
];

describe("BackfillSettingsForm — Apply to existing repositories", () => {
  it("renders candidate repositories with stored and missing release counts", () => {
    const candidates: ReapplyCandidate[] = [
      {
        id: "r1",
        fullName: "facebook/react",
        avatarUrl: "https://avatar.test/react",
        releaseCount: 35,
        backfillTarget: 50,
        backfillNextPage: 2,
        missingReleases: 65,
        oldestRelease: { tagName: "v18.0.0", publishedAt: new Date("2024-05-01T00:00:00Z") },
      },
      {
        id: "r2",
        fullName: "vercel/next.js",
        avatarUrl: null,
        releaseCount: 100,
        backfillTarget: 100,
        backfillNextPage: 3,
        missingReleases: 0,
        oldestRelease: null,
      },
    ];

    const html = renderToStaticMarkup(
      <BackfillSettingsForm settings={mockSettings} candidates={candidates} />,
    );

    expect(html).toContain("Apply to existing repositories");
    expect(html).toContain("facebook/react");
    expect(html).toContain("35 stored");
    expect(html).toContain("+65 missing");
    expect(html).toContain("oldest:");
    expect(html).toContain("v18.0.0");
    expect(html).toContain("vercel/next.js");
    expect(html).toContain("At target (100)");
    expect(html).toContain("2 repos · 65 missing");
  });

  it("renders empty state when no repositories have older releases left", () => {
    const html = renderToStaticMarkup(
      <BackfillSettingsForm settings={mockSettings} candidates={[]} />,
    );

    expect(html).toContain("No repository has older releases left to import right now.");
    expect(html).toContain("disabled");
  });
});
