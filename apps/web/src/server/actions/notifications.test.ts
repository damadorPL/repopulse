import { beforeEach, describe, expect, it, vi } from "vitest";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}

const prisma = {
  notificationRule: { count: vi.fn(), create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  tag: { findFirst: vi.fn() },
};

vi.mock("@/lib/auth", () => ({ UnauthorizedError, ForbiddenError, getCurrentUserOrThrow: vi.fn(async () => ({ id: "u1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@repopulse/db", () => ({ prisma, SmtpPasswordUnreadableError: class extends Error {} }));
vi.mock("@repopulse/github", () => ({
  GitHubRateLimitError: class extends Error {},
  GitHubRepositoryNotFoundError: class extends Error {},
  InvalidRepositoryInputError: class extends Error {},
}));
vi.mock("@repopulse/notifications", () => ({
  buildTestRelease: vi.fn(),
  dispatchNotification: vi.fn(),
  isDeliverableChannel: vi.fn(() => true),
  isNotificationDeliveryError: vi.fn(() => false),
  resolveAppBaseUrl: () => "https://pulse.example.com",
}));
vi.mock("@repopulse/notifications/channels", () => ({
  CHANNEL_INFO: {},
  DELIVERABLE_CHANNELS: ["DISCORD_WEBHOOK", "EMAIL_INSTANT"],
  maskDestination: (_channel: string, url: string | null) => (url ? "masked" : ""),
}));
vi.mock("@/server/notification-destination", () => ({
  normalizeDestination: vi.fn(async (_channel: string, raw: string) => ({ ok: true, data: raw })),
}));
vi.mock("@/server/smtp-settings", () => ({ getSmtpConfig: vi.fn(), isSmtpConfigured: vi.fn(async () => true) }));

const { createNotificationRuleAction, updateNotificationRuleEventsAction } = await import("./notifications");

function ruleRow(extra: Record<string, unknown> = {}) {
  return {
    id: "r1",
    channel: "DISCORD_WEBHOOK",
    destinationUrl: "https://discord.com/api/webhooks/1/secret",
    onlyMajorReleases: false,
    events: ["RELEASES"],
    enabled: true,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    tag: null,
    ...extra,
  };
}

const base = { tagId: null, channel: "DISCORD_WEBHOOK", destinationUrl: "https://discord.com/api/webhooks/1/secret", onlyMajorReleases: false };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.notificationRule.count.mockResolvedValue(0);
  prisma.tag.findFirst.mockResolvedValue({ id: "t1" });
  prisma.notificationRule.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ruleRow({ events: data.events }));
});

describe("createNotificationRuleAction events", () => {
  it("stores the chosen events in a fixed order", async () => {
    const result = await createNotificationRuleAction({ ...base, events: ["DEPENDENCY_PULL_REQUESTS", "DEPENDENCY_UPDATES"] });
    expect(result).toMatchObject({ ok: true, data: { events: ["DEPENDENCY_UPDATES", "DEPENDENCY_PULL_REQUESTS"], destination: "masked" } });
    expect(prisma.notificationRule.create.mock.calls[0]![0].data).toMatchObject({ userId: "u1", events: ["DEPENDENCY_UPDATES", "DEPENDENCY_PULL_REQUESTS"] });
  });

  it("needs at least one event", async () => {
    expect(await createNotificationRuleAction({ ...base, events: [] })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await createNotificationRuleAction({ ...base, events: ["SOMETHING"] } as never)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await createNotificationRuleAction(base as never)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(prisma.notificationRule.create).not.toHaveBeenCalled();
  });

  it("allows only releases on tag-scoped rules", async () => {
    const result = await createNotificationRuleAction({ ...base, tagId: "t1", events: ["RELEASES", "DEPENDENCY_UPDATES"] });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(prisma.notificationRule.create).not.toHaveBeenCalled();

    expect(await createNotificationRuleAction({ ...base, tagId: "t1", events: ["RELEASES"] })).toMatchObject({ ok: true });
  });
});

describe("updateNotificationRuleEventsAction", () => {
  it("updates the user's own rule", async () => {
    prisma.notificationRule.findFirst
      .mockResolvedValueOnce({ tagId: null })
      .mockResolvedValueOnce(ruleRow({ events: ["RELEASES", "DEPENDENCY_UPDATES"] }));
    prisma.notificationRule.updateMany.mockResolvedValue({ count: 1 });
    const result = await updateNotificationRuleEventsAction({ ruleId: "r1", events: ["DEPENDENCY_UPDATES", "RELEASES"] });
    expect(result).toMatchObject({ ok: true, data: { events: ["RELEASES", "DEPENDENCY_UPDATES"] } });
    expect(prisma.notificationRule.findFirst.mock.calls[0]![0].where).toEqual({ id: "r1", userId: "u1" });
    expect(prisma.notificationRule.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", userId: "u1" },
      data: { events: ["RELEASES", "DEPENDENCY_UPDATES"] },
    });
  });

  it("returns NOT_FOUND for someone else's rule", async () => {
    prisma.notificationRule.findFirst.mockResolvedValueOnce(null);
    expect(await updateNotificationRuleEventsAction({ ruleId: "r1", events: ["RELEASES"] })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(prisma.notificationRule.updateMany).not.toHaveBeenCalled();
  });

  it("refuses dependency events on a tag-scoped rule and empty lists", async () => {
    prisma.notificationRule.findFirst.mockResolvedValueOnce({ tagId: "t1" });
    expect(await updateNotificationRuleEventsAction({ ruleId: "r1", events: ["DEPENDENCY_PULL_REQUESTS"] })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await updateNotificationRuleEventsAction({ ruleId: "r1", events: [] })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(prisma.notificationRule.updateMany).not.toHaveBeenCalled();
  });
});
