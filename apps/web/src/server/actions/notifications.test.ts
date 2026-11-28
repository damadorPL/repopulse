import { beforeEach, describe, expect, it, vi } from "vitest";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}
class SmtpPasswordUnreadableError extends Error {}

const prisma = {
  notificationRule: {
    count: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  tag: { findFirst: vi.fn() },
};

const dispatchNotification = vi.fn();
const isDeliverableChannel = vi.fn(() => true);
const isNotificationDeliveryError = vi.fn(() => false);
const getSmtpConfig = vi.fn();

vi.mock("@/lib/auth", () => ({
  UnauthorizedError,
  ForbiddenError,
  getCurrentUserOrThrow: vi.fn(async () => ({ id: "u1", email: "u1@example.com", name: "User 1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@repopulse/db", () => ({ prisma, SmtpPasswordUnreadableError }));
vi.mock("@repopulse/github", () => ({
  GitHubRateLimitError: class extends Error {},
  GitHubRepositoryNotFoundError: class extends Error {},
  InvalidRepositoryInputError: class extends Error {},
}));
vi.mock("@repopulse/notifications", () => ({
  buildTestRelease: vi.fn(() => ({ release: {}, repository: {} })),
  dispatchNotification,
  isDeliverableChannel,
  isNotificationDeliveryError,
  resolveAppBaseUrl: () => "https://pulse.example.com",
}));
vi.mock("@repopulse/notifications/channels", () => ({
  CHANNEL_INFO: { DISCORD_WEBHOOK: { label: "Discord" }, EMAIL_INSTANT: { label: "Email" } },
  DELIVERABLE_CHANNELS: ["DISCORD_WEBHOOK", "EMAIL_INSTANT"],
  maskDestination: (_channel: string, url: string | null) => (url ? "masked" : ""),
}));
const normalizeDestination = vi.fn(async (channel: string, raw: string) => ({
  ok: true,
  data: channel === "EMAIL_INSTANT" && raw.trim() === "" ? null : raw.trim(),
}));
vi.mock("@/server/notification-destination", () => ({
  normalizeDestination,
}));
vi.mock("@/server/smtp-settings", () => ({ getSmtpConfig, isSmtpConfigured: vi.fn(async () => true) }));

const {
  createNotificationRuleAction,
  deleteNotificationRuleAction,
  sendTestNotificationAction,
  toggleNotificationRuleAction,
  updateNotificationRuleAction,
} = await import("./notifications");

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

const base = {
  tagId: null,
  channel: "DISCORD_WEBHOOK",
  destinationUrl: "https://discord.com/api/webhooks/1/secret",
  onlyMajorReleases: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.notificationRule.count.mockResolvedValue(0);
  prisma.tag.findFirst.mockResolvedValue({ id: "t1" });
  prisma.notificationRule.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    ruleRow({ events: data.events }),
  );
});

describe("createNotificationRuleAction events", () => {
  it("stores the chosen events in a fixed order", async () => {
    const result = await createNotificationRuleAction({
      ...base,
      events: ["DEPENDENCY_PULL_REQUESTS", "DEPENDENCY_UPDATES"],
    });
    expect(result).toMatchObject({
      ok: true,
      data: { events: ["DEPENDENCY_UPDATES", "DEPENDENCY_PULL_REQUESTS"], destination: "masked" },
    });
    expect(prisma.notificationRule.create.mock.calls[0]![0].data).toMatchObject({
      userId: "u1",
      events: ["DEPENDENCY_UPDATES", "DEPENDENCY_PULL_REQUESTS"],
    });
  });

  it("needs at least one event", async () => {
    await expect(createNotificationRuleAction({ ...base, events: [] })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    await expect(createNotificationRuleAction({ ...base, events: ["SOMETHING"] } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    await expect(createNotificationRuleAction(base as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(prisma.notificationRule.create).not.toHaveBeenCalled();
  });

  it("allows only releases on tag-scoped rules", async () => {
    const result = await createNotificationRuleAction({
      ...base,
      tagId: "t1",
      events: ["RELEASES", "DEPENDENCY_UPDATES"],
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(prisma.notificationRule.create).not.toHaveBeenCalled();

    await expect(createNotificationRuleAction({ ...base, tagId: "t1", events: ["RELEASES"] })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("enforces MAX_NOTIFICATION_RULES (25) with CONFLICT and rejects a foreign tagId with NOT_FOUND", async () => {
    prisma.notificationRule.count.mockResolvedValueOnce(25);
    await expect(createNotificationRuleAction({ ...base, events: ["RELEASES"] })).resolves.toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(prisma.notificationRule.create).not.toHaveBeenCalled();

    prisma.tag.findFirst.mockResolvedValueOnce(null);
    await expect(
      createNotificationRuleAction({ ...base, tagId: "foreign-tag", events: ["RELEASES"] }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(prisma.tag.findFirst).toHaveBeenCalledWith({
      where: { id: "foreign-tag", userId: "u1" },
      select: { id: true },
    });
  });
});

describe("toggleNotificationRuleAction and deleteNotificationRuleAction", () => {
  it("scopes toggle and delete to the current user", async () => {
    prisma.notificationRule.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(toggleNotificationRuleAction({ ruleId: "r-other", enabled: false })).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(prisma.notificationRule.updateMany).toHaveBeenCalledWith({
      where: { id: "r-other", userId: "u1" },
      data: { enabled: false },
    });

    prisma.notificationRule.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(toggleNotificationRuleAction({ ruleId: "r1", enabled: false })).resolves.toEqual({
      ok: true,
      data: { ruleId: "r1", enabled: false },
    });

    prisma.notificationRule.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(deleteNotificationRuleAction({ ruleId: "r-other" })).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(prisma.notificationRule.deleteMany).toHaveBeenCalledWith({
      where: { id: "r-other", userId: "u1" },
    });

    prisma.notificationRule.deleteMany.mockResolvedValueOnce({ count: 1 });
    await expect(deleteNotificationRuleAction({ ruleId: "r1" })).resolves.toEqual({
      ok: true,
      data: { ruleId: "r1" },
    });
  });
});

describe("sendTestNotificationAction", () => {
  let now = 1_700_000_000_000;

  beforeEach(() => {
    now += 20_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  it("scopes rule lookup to the user, enforces per-rule cooldown, and maps delivery errors to DELIVERY_FAILED", async () => {
    prisma.notificationRule.findFirst.mockResolvedValueOnce(null);
    await expect(sendTestNotificationAction({ ruleId: "r-other" })).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(prisma.notificationRule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r-other", userId: "u1" } }),
    );

    prisma.notificationRule.findFirst.mockResolvedValue(ruleRow({ id: "r-test", channel: "EMAIL_INSTANT" }));
    dispatchNotification.mockResolvedValueOnce({ destination: "u1@example.com" });

    const sent = await sendTestNotificationAction({ ruleId: "r-test" });
    expect(sent).toEqual({ ok: true, data: { channel: "Email", destination: "u1@example.com" } });

    // Within 10s cooldown for r-test
    now += 2_000;
    await expect(sendTestNotificationAction({ ruleId: "r-test" })).resolves.toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });

    // Advance past cooldown and test error mappings
    now += 10_000;
    getSmtpConfig.mockRejectedValueOnce(new SmtpPasswordUnreadableError("Unreadable key"));
    await expect(sendTestNotificationAction({ ruleId: "r-test" })).resolves.toEqual({
      ok: false,
      error: { code: "DELIVERY_FAILED", message: "Unreadable key" },
    });

    now += 10_000;
    isNotificationDeliveryError.mockReturnValueOnce(true);
    dispatchNotification.mockRejectedValueOnce(new Error("Webhook 500"));
    await expect(sendTestNotificationAction({ ruleId: "r-test" })).resolves.toEqual({
      ok: false,
      error: { code: "DELIVERY_FAILED", message: "Webhook 500" },
    });
  });
});

describe("updateNotificationRuleAction", () => {
  it("updates events, scope, major-only flag, and destination on the user's own rule", async () => {
    prisma.notificationRule.findFirst
      .mockResolvedValueOnce({
        id: "r1",
        channel: "DISCORD_WEBHOOK",
        tagId: null,
        events: ["RELEASES"],
        onlyMajorReleases: false,
      })
      .mockResolvedValueOnce(
        ruleRow({
          events: ["RELEASES", "DEPENDENCY_UPDATES"],
          onlyMajorReleases: true,
          destinationUrl: "https://discord.com/api/webhooks/2/new",
        }),
      );
    prisma.notificationRule.updateMany.mockResolvedValue({ count: 1 });
    const result = await updateNotificationRuleAction({
      ruleId: "r1",
      events: ["DEPENDENCY_UPDATES", "RELEASES"],
      onlyMajorReleases: true,
      destinationUrl: "https://discord.com/api/webhooks/2/new",
    });
    expect(result).toMatchObject({
      ok: true,
      data: { events: ["RELEASES", "DEPENDENCY_UPDATES"], onlyMajorReleases: true },
    });
    expect(prisma.notificationRule.findFirst.mock.calls[0]![0].where).toEqual({ id: "r1", userId: "u1" });
    expect(prisma.notificationRule.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", userId: "u1" },
      data: {
        events: ["RELEASES", "DEPENDENCY_UPDATES"],
        onlyMajorReleases: true,
        destinationUrl: "https://discord.com/api/webhooks/2/new",
      },
    });
  });

  it("clears custom email recipient back to account email when destinationUrl is empty", async () => {
    prisma.notificationRule.findFirst
      .mockResolvedValueOnce({
        id: "r2",
        channel: "EMAIL_INSTANT",
        tagId: null,
        events: ["RELEASES"],
        onlyMajorReleases: false,
      })
      .mockResolvedValueOnce(ruleRow({ id: "r2", channel: "EMAIL_INSTANT", destinationUrl: null }));
    prisma.notificationRule.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateNotificationRuleAction({ ruleId: "r2", destinationUrl: "" });
    expect(result).toMatchObject({ ok: true, data: { usesAccountEmail: true } });
    expect(normalizeDestination).toHaveBeenCalledWith("EMAIL_INSTANT", "", { smtpConfigured: true });
    expect(prisma.notificationRule.updateMany).toHaveBeenCalledWith({
      where: { id: "r2", userId: "u1" },
      data: { destinationUrl: null },
    });
  });

  it("returns NOT_FOUND for someone else's rule or a foreign tagId", async () => {
    prisma.notificationRule.findFirst.mockResolvedValueOnce(null);
    await expect(updateNotificationRuleAction({ ruleId: "r1", events: ["RELEASES"] })).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });

    prisma.notificationRule.findFirst.mockResolvedValueOnce({
      id: "r1",
      channel: "DISCORD_WEBHOOK",
      tagId: null,
      events: ["RELEASES"],
      onlyMajorReleases: false,
    });
    prisma.tag.findFirst.mockResolvedValueOnce(null);
    await expect(updateNotificationRuleAction({ ruleId: "r1", tagId: "foreign-tag" })).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(prisma.notificationRule.updateMany).not.toHaveBeenCalled();
  });

  it("refuses dependency events on a tag-scoped rule, switching to tag scope with dependency events, empty event lists, and empty patches", async () => {
    prisma.notificationRule.findFirst.mockResolvedValueOnce({
      id: "r1",
      channel: "DISCORD_WEBHOOK",
      tagId: "t1",
      events: ["RELEASES"],
      onlyMajorReleases: false,
    });
    await expect(
      updateNotificationRuleAction({ ruleId: "r1", events: ["DEPENDENCY_PULL_REQUESTS"] }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });

    prisma.notificationRule.findFirst.mockResolvedValueOnce({
      id: "r1",
      channel: "DISCORD_WEBHOOK",
      tagId: null,
      events: ["RELEASES", "DEPENDENCY_UPDATES"],
      onlyMajorReleases: false,
    });
    await expect(updateNotificationRuleAction({ ruleId: "r1", tagId: "t1" })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });

    await expect(updateNotificationRuleAction({ ruleId: "r1", events: [] })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    await expect(updateNotificationRuleAction({ ruleId: "r1" })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(prisma.notificationRule.updateMany).not.toHaveBeenCalled();
  });
});
