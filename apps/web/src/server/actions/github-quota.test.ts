import { beforeEach, describe, expect, it, vi } from "vitest";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}

const currentUser = { id: "admin1", isSuperAdmin: true };

const getGitHubQuotaView = vi.fn();

vi.mock("@/lib/auth", () => ({
  UnauthorizedError,
  ForbiddenError,
  getCurrentUserOrThrow: vi.fn(async () => currentUser),
}));

vi.mock("@/server/queries/github-quota", () => ({
  getGitHubQuotaView,
}));

const { getCurrentUserOrThrow } = await import("@/lib/auth");
const { refreshGitHubQuotaAction } = await import("./github-quota");

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.isSuperAdmin = true;
  vi.mocked(getCurrentUserOrThrow).mockResolvedValue(currentUser as never);
});

describe("refreshGitHubQuotaAction", () => {
  it("returns FORBIDDEN for non-super admins and UNAUTHORIZED when signed out", async () => {
    currentUser.isSuperAdmin = false;
    expect(await refreshGitHubQuotaAction()).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    vi.mocked(getCurrentUserOrThrow).mockRejectedValueOnce(new UnauthorizedError("Not signed in"));
    expect(await refreshGitHubQuotaAction()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
  });

  it("returns quota data when query succeeds", async () => {
    const quotaData = {
      limit: 5000,
      remaining: 4500,
      used: 500,
      resetAt: "2026-11-05T19:00:00.000Z",
      authenticated: true,
      login: "admin",
    };
    getGitHubQuotaView.mockResolvedValueOnce({ ok: true, data: quotaData });

    const result = await refreshGitHubQuotaAction();
    expect(result).toEqual({ ok: true, data: quotaData });
  });

  it("returns INTERNAL error when query fails", async () => {
    getGitHubQuotaView.mockResolvedValueOnce({ ok: false, error: "Network error" });

    const result = await refreshGitHubQuotaAction();
    expect(result).toEqual({ ok: false, error: { code: "INTERNAL", message: "Network error" } });
  });
});
