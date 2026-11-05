import { describe, expect, it, vi } from "vitest";

const prisma = {
  user: { findFirst: vi.fn() },
};

const decryptToken = vi.fn((val: string) => `decrypted_${val}`);

vi.mock("@repopulse/db", () => ({ prisma, decryptToken }));

const { getGitHubQuotaView } = await import("./github-quota");

describe("getGitHubQuotaView", () => {
  it("returns authenticated quota using admin token", async () => {
    const adminUser = {
      id: "admin1",
      isSuperAdmin: true,
      githubLogin: "octocat",
      githubAccessTokenEncrypted: "admin_token",
    };

    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          rate: { limit: 5000, remaining: 4900, reset: 1700000000, used: 100 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await getGitHubQuotaView(adminUser as never, { fetch: mockFetch as never });

    expect(result).toEqual({
      ok: true,
      data: {
        limit: 5000,
        remaining: 4900,
        used: 100,
        resetAt: new Date(1700000000 * 1000).toISOString(),
        authenticated: true,
        login: "octocat",
      },
    });
  });

  it("falls back to another subscriber's token when admin has none", async () => {
    const adminUser = {
      id: "admin1",
      isSuperAdmin: true,
      githubLogin: null,
      githubAccessTokenEncrypted: null,
    };

    prisma.user.findFirst.mockResolvedValueOnce({
      githubAccessTokenEncrypted: "sub_token",
      githubLogin: "subscriber_user",
    });

    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          rate: { limit: 5000, remaining: 4800, reset: 1700001000, used: 200 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await getGitHubQuotaView(adminUser as never, { fetch: mockFetch as never });

    expect(result).toEqual({
      ok: true,
      data: {
        limit: 5000,
        remaining: 4800,
        used: 200,
        resetAt: new Date(1700001000 * 1000).toISOString(),
        authenticated: true,
        login: "subscriber_user",
      },
    });
  });

  it("queries anonymously when no token exists anywhere", async () => {
    const adminUser = {
      id: "admin1",
      isSuperAdmin: true,
      githubLogin: null,
      githubAccessTokenEncrypted: null,
    };

    prisma.user.findFirst.mockResolvedValueOnce(null);

    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          rate: { limit: 60, remaining: 55, reset: 1700002000, used: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await getGitHubQuotaView(adminUser as never, { fetch: mockFetch as never });

    expect(result).toEqual({
      ok: true,
      data: {
        limit: 60,
        remaining: 55,
        used: 5,
        resetAt: new Date(1700002000 * 1000).toISOString(),
        authenticated: false,
        login: null,
      },
    });
  });

  it("returns ok: false when GitHub API returns an error", async () => {
    const adminUser = {
      id: "admin1",
      isSuperAdmin: true,
      githubLogin: "octocat",
      githubAccessTokenEncrypted: "token",
    };

    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await getGitHubQuotaView(adminUser as never, { fetch: mockFetch as never });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Bad credentials");
    }
  });
});
