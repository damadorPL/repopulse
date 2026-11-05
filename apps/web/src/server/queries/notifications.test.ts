import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = {
  notificationRule: { findMany: vi.fn() },
};

vi.mock("@repopulse/db", () => ({ prisma }));

const { getNotificationRules } = await import("./notifications");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getNotificationRules", () => {
  it("queries the user's rules, normalizes events, and masks destinations", async () => {
    const createdAt = new Date("2026-11-01T00:00:00Z");
    prisma.notificationRule.findMany.mockResolvedValueOnce([
      {
        id: "r1",
        channel: "DISCORD_WEBHOOK",
        destinationUrl: "https://discord.com/api/webhooks/123456/super-secret-token",
        onlyMajorReleases: false,
        events: ["DEPENDENCY_PULL_REQUESTS", "RELEASES"],
        enabled: true,
        createdAt,
        tag: null,
      },
    ]);

    const rules = await getNotificationRules("u1");
    expect(prisma.notificationRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1" } }),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]!.events).toEqual(["RELEASES", "DEPENDENCY_PULL_REQUESTS"]);
    expect(rules[0]!.destination).not.toContain("super-secret-token");
    expect(rules[0]).not.toHaveProperty("destinationUrl");
  });
});
