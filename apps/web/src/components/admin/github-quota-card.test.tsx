import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GitHubQuotaCard } from "./github-quota-card";

vi.mock("@/server/actions/github-quota", () => ({
  refreshGitHubQuotaAction: vi.fn(),
}));

describe("GitHubQuotaCard", () => {
  it("renders healthy authenticated quota with remaining count and threshold", () => {
    const html = renderToStaticMarkup(
      <GitHubQuotaCard
        initialQuota={{
          ok: true,
          data: {
            limit: 5000,
            remaining: 4500,
            used: 500,
            resetAt: "2026-11-05T19:30:00.000Z",
            authenticated: true,
            login: "admin",
          },
        }}
        minQuota={500}
      />,
    );

    expect(html).toContain("GitHub API quota");
    expect(html).toContain("4,500");
    expect(html).toContain("/ 5,000");
    expect(html).toContain("500 requests used this hour");
    expect(html).toContain("Quota healthy");
    expect(html).toContain("@admin");
  });

  it("renders warning badge when remaining quota is at or below minimum threshold", () => {
    const html = renderToStaticMarkup(
      <GitHubQuotaCard
        initialQuota={{
          ok: true,
          data: {
            limit: 5000,
            remaining: 350,
            used: 4650,
            resetAt: "2026-11-05T19:30:00.000Z",
            authenticated: true,
            login: "admin",
          },
        }}
        minQuota={500}
      />,
    );

    expect(html).toContain("Below minimum quota");
    expect(html).toContain("350");
    expect(html).toContain("Imports paused until reset");
  });

  it("renders error state when quota retrieval failed", () => {
    const html = renderToStaticMarkup(
      <GitHubQuotaCard
        initialQuota={{
          ok: false,
          error: "GitHub API connection timed out",
        }}
        minQuota={500}
      />,
    );

    expect(html).toContain("Could not read GitHub rate limit");
    expect(html).toContain("GitHub API connection timed out");
    expect(html).toContain("Retry");
  });
});
