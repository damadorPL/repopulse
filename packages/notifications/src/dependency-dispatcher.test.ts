import { describe, expect, it, vi } from "vitest";
import { dispatchDependencyNotification } from "./dependency-dispatcher.js";
import { NotificationDeliveryError, WebhookUrlError } from "./errors.js";
import type { MailSender } from "./formatters/email.js";
import type { DependencyNotificationInput } from "./formatters/dependencies.js";
import type { WebhookSender } from "./http.js";
import type { NotificationChannel } from "./types.js";

function input(channel: NotificationChannel, destinationUrl: string | null, extra: Partial<DependencyNotificationInput> = {}): DependencyNotificationInput {
  return {
    project: { fullName: "acme/widget", url: "https://pulse.example.com/dependencies/acme/widget" },
    kind: "digest",
    updates: [{ name: "react", from: "18.3.1", to: "19.3.0", level: "MAJOR", manifest: "package.json", ecosystem: "NPM" }],
    rule: { id: "rule1", channel, destinationUrl },
    user: { email: "dev@example.com" },
    ...extra,
  };
}

const SMTP = { host: "smtp.example.com", port: 587, secure: false, user: undefined, pass: undefined, from: "RepoPulse <r@example.com>" };

describe("dispatchDependencyNotification", () => {
  it.each([
    ["DISCORD_WEBHOOK", "https://discord.com/api/webhooks/1/token", "application/json"],
    ["SLACK_WEBHOOK", "https://hooks.slack.com/services/T/B/X", "application/json"],
    ["NTFY_WEBHOOK", "https://ntfy.sh/alerts", "text/markdown; charset=utf-8"],
    ["GOTIFY_WEBHOOK", "https://gotify.example.com/message?token=abc", "application/json"],
    ["CUSTOM_WEBHOOK", "https://example.com/hook", "application/json"],
  ] as const)("routes %s through the webhook sender", async (channel, url, contentType) => {
    const sendWebhook = vi.fn<WebhookSender>(async () => ({ status: 204, body: "" }));
    const result = await dispatchDependencyNotification(input(channel, url), { env: {}, sendWebhook, timeoutMs: 1234 });
    expect(result).toMatchObject({ channel, status: 204 });
    expect(result.destination).not.toContain("token=abc");
    const [request, options] = sendWebhook.mock.calls[0]!;
    expect(request.headers["Content-Type"]).toBe(contentType);
    expect(request.destination).toBe(result.destination);
    expect(request.body).toContain("react");
    expect(options).toMatchObject({ policy: { mode: "none" }, timeoutMs: 1234 });
  });

  it("sets X-RepoPulse-Event on custom webhooks", async () => {
    const sendWebhook = vi.fn<WebhookSender>(async () => ({ status: 200, body: "" }));
    await dispatchDependencyNotification(input("CUSTOM_WEBHOOK", "https://example.com/hook"), { env: {}, sendWebhook });
    await dispatchDependencyNotification(
      input("CUSTOM_WEBHOOK", "https://example.com/hook", {
        kind: "pull_request",
        pullRequest: { event: "opened", number: 3, url: "https://github.com/acme/widget/pull/3", title: "Update react" },
      }),
      { env: {}, sendWebhook },
    );
    await dispatchDependencyNotification(input("CUSTOM_WEBHOOK", "https://example.com/hook", { test: true }), { env: {}, sendWebhook });
    const events = sendWebhook.mock.calls.map(([request]) => request.headers["X-RepoPulse-Event"]);
    expect(events).toEqual(["dependencies.outdated", "dependencies.pull_request", "test"]);
    const body = JSON.parse(sendWebhook.mock.calls[1]![0].body) as { event: string; pullRequest: { number: number } };
    expect(body.event).toBe("dependencies.pull_request");
    expect(body.pullRequest.number).toBe(3);
  });

  it("passes the SSRF policy from the environment", async () => {
    const sendWebhook = vi.fn<WebhookSender>(async () => ({ status: 200, body: "" }));
    await dispatchDependencyNotification(input("NTFY_WEBHOOK", "https://ntfy.lan/t"), {
      env: { ALLOW_INTERNAL_WEBHOOK_HOSTS: "true" },
      sendWebhook,
    });
    expect(sendWebhook.mock.calls[0]![1].policy).toEqual({ mode: "all" });
  });

  it("sends email to the rule's address, or the user's email", async () => {
    const sendMail = vi.fn<MailSender>(async () => {});
    await dispatchDependencyNotification(input("EMAIL_INSTANT", null), { env: {}, smtp: SMTP, sendMail });
    await dispatchDependencyNotification(input("EMAIL_INSTANT", "team@example.com"), { env: {}, smtp: SMTP, sendMail });
    const sent = sendMail.mock.calls.map(([message]) => message);
    expect(sent.map((m) => m.to)).toEqual(["dev@example.com", "team@example.com"]);
    expect(sent[0]).toMatchObject({ from: SMTP.from, subject: "acme/widget: 1 outdated dependency (major)" });
    expect(sent[0]?.html).toContain("<table");
  });

  it("fails permanently without SMTP, a recipient, a destination, or for IN_APP / EMAIL_DIGEST", async () => {
    await expect(dispatchDependencyNotification(input("EMAIL_INSTANT", null), { env: {} })).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining("Admin → Email"),
    });
    await expect(
      dispatchDependencyNotification(input("EMAIL_INSTANT", null, { user: null }), { env: {}, smtp: SMTP, sendMail: async () => {} }),
    ).rejects.toMatchObject({ permanent: true });
    await expect(dispatchDependencyNotification(input("SLACK_WEBHOOK", null), { env: {} })).rejects.toMatchObject({ permanent: true });
    for (const channel of ["IN_APP", "EMAIL_DIGEST"] as const) {
      const error = await dispatchDependencyNotification(input(channel, null), { env: {} }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotificationDeliveryError);
      expect((error as NotificationDeliveryError).permanent).toBe(true);
    }
  });

  it("rejects malformed URLs and a Gotify URL without a token as permanent", async () => {
    const sendWebhook = vi.fn<WebhookSender>(async () => ({ status: 200, body: "" }));
    await expect(dispatchDependencyNotification(input("DISCORD_WEBHOOK", "not a url"), { env: {}, sendWebhook })).rejects.toMatchObject({
      permanent: true,
    });
    await expect(
      dispatchDependencyNotification(input("GOTIFY_WEBHOOK", "https://gotify.example.com"), { env: {}, sendWebhook }),
    ).rejects.toBeInstanceOf(WebhookUrlError);
    expect(sendWebhook).not.toHaveBeenCalled();
  });

  it("blocks a private destination before sending anything (real transport)", async () => {
    const error = await dispatchDependencyNotification(input("CUSTOM_WEBHOOK", "http://127.0.0.1:9/hook"), { env: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebhookUrlError);
  });

  it("propagates transient sender errors unchanged", async () => {
    const failure = new NotificationDeliveryError("Discord rejected the notification: HTTP 503.", { permanent: false, status: 503 });
    const sendWebhook = vi.fn<WebhookSender>(async () => {
      throw failure;
    });
    await expect(
      dispatchDependencyNotification(input("DISCORD_WEBHOOK", "https://discord.com/api/webhooks/1/t"), { env: {}, sendWebhook }),
    ).rejects.toBe(failure);
  });
});
