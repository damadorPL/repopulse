import { describe, expect, it, vi } from "vitest";
import { UnrecoverableError } from "bullmq";
import { NotificationDeliveryError, type dispatchDependencyNotification } from "@repopulse/notifications";
import type { DepsNotifyJobData } from "@repopulse/queue";
import { createFakePrisma, seed } from "../testing/fake-prisma";
import { job, NOW } from "../testing/fixtures";
import { processDepsNotify } from "./deps-notify.processor";
import { passesDependencyNotificationLevel } from "./notify-jobs";

function setup(options: { rule?: Record<string, unknown>; project?: Record<string, unknown>; depsEnabled?: boolean } = {}) {
  const prisma = createFakePrisma();
  seed(prisma, { project: { updateMode: "MANUAL_PR", ...options.project }, ...(options.depsEnabled === false ? { depsEnabled: false } : {}) });
  prisma.notificationRule.rows.push({
    id: "r1",
    userId: "u1",
    tagId: null,
    channel: "DISCORD_WEBHOOK",
    destinationUrl: "https://discord.com/api/webhooks/1/x",
    enabled: true,
    events: ["DEPENDENCY_UPDATES", "DEPENDENCY_PULL_REQUESTS"],
    ...options.rule,
  });
  prisma.dependencyManifest.rows.push({ id: "m1", projectId: "p1", path: "package.json", ecosystem: "NPM" });
  prisma.dependencyUpdate.rows.push(
    { id: "d1", projectId: "p1", manifestId: "m1", name: "react", status: "OUTDATED", currentVersion: "18.2.0", targetVersion: "19.0.0", level: "MAJOR" },
    { id: "d2", projectId: "p1", manifestId: "m1", name: "lodash", status: "OUTDATED", currentVersion: "4.17.0", targetVersion: "4.17.21", level: "PATCH" },
  );
  prisma.dependencyPullRequest.rows.push({ id: "pr1", projectId: "p1", groupKey: "all", number: 3, htmlUrl: "https://github.com/acme/widget/pull/3", state: "OPEN", headSha: "h", targets: ["package.json#react@19.0.0"] });
  const dispatch = vi.fn<typeof dispatchDependencyNotification>(async ({ rule }) => ({ channel: rule.channel, destination: "discord.com/••••", status: 204 }));
  return { prisma, deps: { prisma: prisma as never, dispatch, appBaseUrl: "https://pulse.example.com" }, dispatch };
}

const digest = (updateIds = ["d1", "d2"]): DepsNotifyJobData => ({ ruleId: "r1", projectId: "p1", kind: "digest", scanId: "s1", updateIds });
const prEvent = (event: "opened" | "access_lost" = "opened"): DepsNotifyJobData => ({ ruleId: "r1", projectId: "p1", kind: "pull_request", prId: "pr1", event, dedupKey: "h" });

describe("processDepsNotify", () => {
  it("delivers a digest with the updates still at or above the level", async () => {
    const { deps, dispatch } = setup();
    expect(await processDepsNotify(job(digest()), deps)).toEqual({ status: "SENT", channel: "DISCORD_WEBHOOK", destination: "discord.com/••••" });
    const [input, options] = dispatch.mock.calls[0]!;
    expect(input).toMatchObject({
      kind: "digest",
      project: { fullName: "acme/widget", url: "https://pulse.example.com/dependencies/acme/widget", htmlUrl: "https://github.com/acme/widget" },
      updates: [{ name: "react", from: "18.2.0", to: "19.0.0", level: "MAJOR", manifest: "package.json", ecosystem: "NPM" }],
      user: { email: "dev@example.com" },
    });
    expect(options).toMatchObject({ smtp: null, appBaseUrl: "https://pulse.example.com" });
  });

  it("delivers PR events with the PR's targets", async () => {
    const { deps, dispatch } = setup();
    await processDepsNotify(job(prEvent()), deps);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      kind: "pull_request",
      pullRequest: { event: "opened", number: 3, url: "https://github.com/acme/widget/pull/3" },
      updates: [{ name: "react", from: "18.2.0", to: "19.0.0", manifest: "package.json" }],
    });
  });

  it.each([
    ["DISABLED", { depsEnabled: false }],
    ["RULE_DISABLED", { rule: { enabled: false } }],
    ["EVENT_DISABLED", { rule: { events: ["RELEASES"] } }],
    ["TAG_SCOPED", { rule: { tagId: "t1" } }],
    ["UNSUPPORTED_CHANNEL", { rule: { channel: "IN_APP" } }],
    ["RULE_GONE", { rule: { userId: "someone-else" } }],
    ["NOTIFICATION_LEVEL", { project: { notificationLevel: "NONE" } }],
  ] as const)("skips with %s", async (reason, options) => {
    const { deps, dispatch } = setup(options as never);
    expect(await processDepsNotify(job(digest()), deps)).toEqual({ status: "SKIPPED", reason });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("skips a digest whose updates are gone or below the level now", async () => {
    const { deps } = setup({ project: { notificationLevel: "MAJOR_ONLY" } });
    expect(await processDepsNotify(job(digest(["d2"])), deps)).toEqual({ status: "SKIPPED", reason: "NOTHING_LEFT" });
  });

  it("skips PR events after a switch to notify-only, except access_lost", async () => {
    const { deps, dispatch } = setup({ project: { updateMode: "NOTIFY" } });
    expect(await processDepsNotify(job(prEvent("opened")), deps)).toEqual({ status: "SKIPPED", reason: "MODE_CHANGED" });
    expect(await processDepsNotify(job(prEvent("access_lost")), deps)).toMatchObject({ status: "SENT" });
    expect(dispatch.mock.calls[0]![0].pullRequest).toMatchObject({ event: "access_lost" });
  });

  it("fails permanently on a permanent delivery error or unreadable SMTP password, retries transient ones, and skips PROJECT_GONE / PULL_REQUEST_GONE", async () => {
    const { deps, dispatch } = setup();
    dispatch.mockRejectedValueOnce(new NotificationDeliveryError("Discord rejected the webhook (HTTP 404).", { permanent: true }));
    await expect(processDepsNotify(job(digest()), deps)).rejects.toBeInstanceOf(UnrecoverableError);
    dispatch.mockRejectedValueOnce(new NotificationDeliveryError("HTTP 502", { permanent: false }));
    await expect(processDepsNotify(job(digest()), deps)).rejects.not.toBeInstanceOf(UnrecoverableError);

    //PROJECT_GONE and PULL_REQUEST_GONE skip reasons
    expect(await processDepsNotify(job({ ...digest(), projectId: "missing-project" }), deps)).toEqual({
      status: "SKIPPED",
      reason: "PROJECT_GONE",
    });
    expect(await processDepsNotify(job({ ...prEvent("opened"), prId: "missing-pr" }), deps)).toEqual({
      status: "SKIPPED",
      reason: "PULL_REQUEST_GONE",
    });

    // SmtpPasswordUnreadableError on EMAIL_INSTANT channel -> permanent failure -> UnrecoverableError
    const emailCtx = setup({ rule: { channel: "EMAIL_INSTANT", destinationUrl: null } });
    emailCtx.prisma.instanceSettings.rows[0] = {
      ...emailCtx.prisma.instanceSettings.rows[0],
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpFrom: "noreply@example.com",
      smtpUser: "user",
      smtpPasswordEncrypted: "corrupt-ciphertext",
    };
    await expect(processDepsNotify(job(digest()), emailCtx.deps)).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe("passesDependencyNotificationLevel", () => {
  it("matches the Slice 07 semantics", () => {
    expect(passesDependencyNotificationLevel("ALL", "PATCH")).toBe(true);
    expect(passesDependencyNotificationLevel("MINOR_AND_UP", "MINOR")).toBe(true);
    expect(passesDependencyNotificationLevel("MINOR_AND_UP", "PATCH")).toBe(false);
    expect(passesDependencyNotificationLevel("MINOR_AND_UP", "PRERELEASE")).toBe(false);
    expect(passesDependencyNotificationLevel("MAJOR_ONLY", "MINOR")).toBe(false);
    expect(passesDependencyNotificationLevel("MAJOR_ONLY", "MAJOR")).toBe(true);
    expect(passesDependencyNotificationLevel("NONE", "MAJOR")).toBe(false);
    expect(passesDependencyNotificationLevel("MINOR_AND_UP", null)).toBe(false);
    void NOW;
  });
});
