import { describe, expect, it, vi } from "vitest";
import { UnrecoverableError, type Job } from "bullmq";
import { NotificationDeliveryError, type dispatchNotification } from "@repopulse/notifications";
import type { NotificationJobData } from "@repopulse/queue";
import { processNotification } from "./notification.processor";

type SemverType = "MAJOR" | "MINOR" | "PATCH" | "PRERELEASE" | "OTHER";

const RULE = {
  id: "rule1",
  userId: "u1",
  tagId: "critical" as string | null,
  channel: "DISCORD_WEBHOOK" as string,
  destinationUrl: "https://discord.com/api/webhooks/1/secret",
  onlyMajorReleases: true,
  enabled: true,
  events: ["RELEASES"] as string[],
  tag: { name: "Critical", colorHex: "#EF4444" } as { name: string; colorHex: string } | null,
};

function releaseRow(tagName: string, semverType: SemverType) {
  return {
    id: `rel-${tagName}`,
    repositoryId: "repo1",
    tagName,
    title: tagName,
    bodyMarkdown: "notes",
    htmlUrl: `https://github.com/acme/widget/releases/tag/${tagName}`,
    semverType,
    isPrerelease: false,
    publishedAt: new Date("2026-10-30T12:00:00Z"),
    source: "RELEASE" as const,
    repository: { fullName: "acme/widget", htmlUrl: "https://github.com/acme/widget", avatarUrl: null },
  };
}

function fakePrisma(options: {
  rule?: Partial<typeof RULE> | null;
  release?: ReturnType<typeof releaseRow> | null;
  user?: { id: string; email: string; name: string } | null;
  subscriptionTags?: string[] | null;
  subscription?: { notificationLevel?: string; snoozedUntil?: Date | null };
  smtpHost?: string | null;
  smtpPasswordEncrypted?: string | null;
}) {
  return {
    instanceSettings: {
      findUnique: vi.fn(async () => ({
        smtpHost: options.smtpHost ?? null,
        smtpPort: 587,
        smtpSecure: null,
        smtpUser: null,
        smtpPasswordEncrypted: options.smtpPasswordEncrypted ?? null,
        smtpFrom: null,
      })),
    },
    notificationRule: { findUnique: vi.fn(async () => (options.rule === null ? null : { ...RULE, ...options.rule })) },
    release: { findUnique: vi.fn(async () => (options.release === undefined ? releaseRow("v2.0.0", "MAJOR") : options.release)) },
    user: { findUnique: vi.fn(async () => (options.user === undefined ? { id: "u1", email: "dev@example.com", name: "Dev" } : options.user)) },
    userSubscription: {
      findUnique: vi.fn(async () =>
        options.subscriptionTags === null
          ? null
          : {
              tags: (options.subscriptionTags ?? ["critical"]).map((tagId) => ({ tagId })),
              notificationLevel: "ALL",
              snoozedUntil: null,
              ...options.subscription,
            },
      ),
    },
  };
}

function job(releaseId = "rel-v2.0.0", attemptsMade = 0): Job<NotificationJobData> {
  return { data: { ruleId: "rule1", releaseId, userId: "u1" }, attemptsMade, opts: { attempts: 3 } } as Job<NotificationJobData>;
}

const delivered = () =>
  vi.fn<typeof dispatchNotification>(async ({ rule }) => ({ channel: rule.channel, destination: "discord.com/api/webhooks/1/secr••••", status: 204 }));

describe("processNotification", () => {
  it("Slice 05 acceptance: dispatches a Critical + major-only rule for v2.0.0 (MAJOR)", async () => {
    const prisma = fakePrisma({});
    const dispatch = delivered();
    const outcome = await processNotification(job(), { prisma: prisma as never, dispatch });

    expect(outcome).toEqual({ status: "SENT", channel: "DISCORD_WEBHOOK", destination: "discord.com/api/webhooks/1/secr••••" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [input] = dispatch.mock.calls[0]!;
    expect(input.release.tagName).toBe("v2.0.0");
    expect(input.repository.fullName).toBe("acme/widget");
    expect(input.user.email).toBe("dev@example.com");
    expect(input.rule.tag).toEqual({ name: "Critical", colorHex: "#EF4444" });
  });

  it("Slice 05 acceptance: skips the same rule for v2.0.1 (PATCH)", async () => {
    const dispatch = delivered();
    const prisma = fakePrisma({ release: releaseRow("v2.0.1", "PATCH") });
    expect(await processNotification(job("rel-v2.0.1"), { prisma: prisma as never, dispatch })).toEqual({
      status: "SKIPPED",
      reason: "NOT_MAJOR",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["RULE_GONE", { rule: null }],
    ["RULE_GONE", { rule: { userId: "someone-else" } }],
    ["RULE_GONE", { user: null }],
    ["RULE_DISABLED", { rule: { enabled: false } }],
    ["EVENT_DISABLED", { rule: { events: ["DEPENDENCY_UPDATES", "DEPENDENCY_PULL_REQUESTS"] } }],
    ["RELEASE_GONE", { release: null }],
    ["UNSUPPORTED_CHANNEL", { rule: { channel: "EMAIL_DIGEST" } }],
    ["UNSUBSCRIBED", { subscriptionTags: null }],
    ["TAG_REMOVED", { subscriptionTags: ["other"] }],
    ["SNOOZED", { subscription: { snoozedUntil: new Date(Date.now() + 60_000) } }],
    ["NOTIFICATION_LEVEL", { subscription: { notificationLevel: "NONE" } }],
    [
      "NOTIFICATION_LEVEL",
      { rule: { onlyMajorReleases: false }, release: releaseRow("v2.1.0", "MINOR"), subscription: { notificationLevel: "MAJOR_ONLY" } },
    ],
    [
      "NOTIFICATION_LEVEL",
      { rule: { onlyMajorReleases: false }, release: releaseRow("v2.0.1", "PATCH"), subscription: { notificationLevel: "MINOR_AND_UP" } },
    ],
  ] as const)("skips with %s", async (reason, options) => {
    const dispatch = delivered();
    const outcome = await processNotification(job(), { prisma: fakePrisma(options as never) as never, dispatch });
    expect(outcome).toEqual({ status: "SKIPPED", reason });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("delivers again once a snooze has ended (Slice 07)", async () => {
    const dispatch = delivered();
    const prisma = fakePrisma({ subscription: { snoozedUntil: new Date(Date.now() - 60_000), notificationLevel: "MAJOR_ONLY" } });
    expect((await processNotification(job(), { prisma: prisma as never, dispatch })).status).toBe("SENT");
  });

  it("delivers untagged rules for any subscription and non-major releases when allowed", async () => {
    const dispatch = delivered();
    const prisma = fakePrisma({ rule: { tagId: null, tag: null, onlyMajorReleases: false }, release: releaseRow("v2.0.1", "PATCH"), subscriptionTags: [] });
    expect((await processNotification(job("rel-v2.0.1"), { prisma: prisma as never, dispatch })).status).toBe("SENT");
  });

  it("passes the SMTP settings saved in the UI to email rules only and forwards AbortSignal", async () => {
    const dispatch = delivered();
    const controller = new AbortController();
    const email = fakePrisma({ rule: { channel: "EMAIL_INSTANT", destinationUrl: null }, smtpHost: "smtp.example.com" });
    await processNotification(job(), { prisma: email as never, dispatch, signal: controller.signal });
    expect(dispatch.mock.calls[0]![1]).toMatchObject({
      smtp: { host: "smtp.example.com", port: 587, from: "RepoPulse <repopulse@smtp.example.com>" },
      signal: controller.signal,
    });

    const discord = fakePrisma({});
    await processNotification(job(), { prisma: discord as never, dispatch });
    expect(dispatch.mock.calls[1]![1]).toMatchObject({ smtp: null });
    expect(discord.instanceSettings.findUnique).not.toHaveBeenCalled();
  });

  it("turns SmtpPasswordUnreadableError into UnrecoverableError and rethrows generic DB errors", async () => {
    const dispatch = delivered();
    const unreadable = fakePrisma({
      rule: { channel: "EMAIL_INSTANT", destinationUrl: null },
      smtpHost: "smtp.example.com",
      smtpPasswordEncrypted: "not-valid-ciphertext",
    });
    const error = await processNotification(job(), { prisma: unreadable as never, dispatch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(dispatch).not.toHaveBeenCalled();

    const dbErr = new Error("connection reset");
    const brokenDb = fakePrisma({ rule: { channel: "EMAIL_INSTANT", destinationUrl: null } });
    brokenDb.instanceSettings.findUnique.mockRejectedValueOnce(dbErr);
    await expect(processNotification(job(), { prisma: brokenDb as never, dispatch })).rejects.toBe(dbErr);
  });

  it("turns permanent delivery failures into UnrecoverableError (no retries)", async () => {
    const dispatch = vi.fn<typeof dispatchNotification>(async () => {
      throw new NotificationDeliveryError("Discord rejected the notification: HTTP 404 (Unknown Webhook).", { permanent: true, status: 404 });
    });
    const error = await processNotification(job(), { prisma: fakePrisma({}) as never, dispatch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toContain("Unknown Webhook");
  });

  it("rethrows transient failures so BullMQ retries with backoff", async () => {
    const transient = new NotificationDeliveryError("Discord request to discord.com/… timed out after 10 s.", { permanent: false });
    const dispatch = vi.fn<typeof dispatchNotification>(async () => {
      throw transient;
    });
    await expect(processNotification(job(), { prisma: fakePrisma({}) as never, dispatch })).rejects.toBe(transient);
  });
});
