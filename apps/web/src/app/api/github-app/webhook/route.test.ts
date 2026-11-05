import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

class GitHubAppKeyUnreadableError extends Error {}
class RealtimeUnavailableError extends Error {}

const handleGitHubAppWebhook = vi.fn();

vi.mock("@repopulse/db", () => ({
  prisma: {},
  GitHubAppKeyUnreadableError,
  loadDepsEnabled: vi.fn(),
  loadGitHubAppSettings: vi.fn(),
}));
vi.mock("@/server/deps-webhook-queue", () => ({ enqueueWebhookScan: vi.fn() }));
vi.mock("@/server/github-app-webhook", () => ({ handleGitHubAppWebhook }));
vi.mock("@/server/realtime", () => ({ RealtimeUnavailableError }));

const { POST } = await import("./route");

function makeRequest(): NextRequest {
  return {
    headers: new Headers(),
    body: null,
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/github-app/webhook", () => {
  it("returns the status and body from handleGitHubAppWebhook", async () => {
    handleGitHubAppWebhook.mockResolvedValueOnce({ status: 204 });
    const res204 = await POST(makeRequest());
    expect(res204.status).toBe(204);

    handleGitHubAppWebhook.mockResolvedValueOnce({ status: 202, body: { queued: 1 } });
    const res202 = await POST(makeRequest());
    expect(res202.status).toBe(202);
    await expect(res202.json()).resolves.toEqual({ queued: 1 });
  });

  it("maps GitHubAppKeyUnreadableError, RealtimeUnavailableError, and unexpected errors to 503 responses", async () => {
    handleGitHubAppWebhook.mockRejectedValueOnce(new GitHubAppKeyUnreadableError("bad key"));
    const keyRes = await POST(makeRequest());
    expect(keyRes.status).toBe(503);
    await expect(keyRes.json()).resolves.toEqual({ error: "webhook secret unreadable" });

    handleGitHubAppWebhook.mockRejectedValueOnce(new RealtimeUnavailableError("redis down"));
    const queueRes = await POST(makeRequest());
    expect(queueRes.status).toBe(503);
    await expect(queueRes.json()).resolves.toEqual({ error: "queue unavailable" });

    handleGitHubAppWebhook.mockRejectedValueOnce(new Error("db timeout"));
    const genericRes = await POST(makeRequest());
    expect(genericRes.status).toBe(503);
    await expect(genericRes.json()).resolves.toEqual({ error: "temporarily unavailable" });
  });
});
