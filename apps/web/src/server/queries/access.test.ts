import { describe, expect, it, vi } from "vitest";

vi.mock("@repopulse/db", () => ({ prisma: {} }));

const { toInviteView } = await import("./access");

describe("toInviteView", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const baseInvite = {
    id: "inv1",
    note: "Team member",
    expiresAt: new Date("2026-11-10T12:00:00Z"),
    usedAt: null as Date | null,
    createdAt: new Date("2026-11-01T12:00:00Z"),
    createdBy: { name: "Alice", email: "alice@example.com" },
    usedBy: null,
  };

  it("computes pending, used, and expired statuses and falls back to creator email when name is null", () => {
    expect(toInviteView(baseInvite, now)).toMatchObject({
      status: "pending",
      createdBy: "Alice",
    });

    expect(
      toInviteView(
        {
          ...baseInvite,
          usedAt: new Date("2026-11-02T12:00:00Z"),
          createdBy: { name: null, email: "alice@example.com" },
        },
        now,
      ),
    ).toMatchObject({
      status: "used",
      createdBy: "alice@example.com",
    });

    expect(
      toInviteView(
        {
          ...baseInvite,
          expiresAt: new Date("2026-11-04T12:00:00Z"),
        },
        now,
      ),
    ).toMatchObject({
      status: "expired",
    });
  });
});
