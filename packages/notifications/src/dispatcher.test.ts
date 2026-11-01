import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTestRelease, dispatchNotification, releaseReaderUrl, resolveAppBaseUrl } from "./dispatcher.js";
import { NotificationDeliveryError, WebhookUrlError } from "./errors.js";
import { postWebhook, type WebhookSender } from "./http.js";
import type { ResolveAll } from "./ssrf-guard.js";
import type { DispatchInput, NotificationChannel } from "./types.js";

function input(channel: NotificationChannel, destinationUrl: string | null): DispatchInput {
  return {
    rule: { id: "rule1", channel, destinationUrl, onlyMajorReleases: true, tag: { name: "Critical", colorHex: "#EF4444" } },
    release: {
      id: "rel1",
      tagName: "v2.0.0",
      title: "v2.0.0",
      bodyMarkdown: "Big one",
      htmlUrl: "https://github.com/acme/widget/releases/tag/v2.0.0",
      semverType: "MAJOR",
      isPrerelease: false,
      publishedAt: new Date("2026-10-30T12:00:00Z"),
    },
    repository: { fullName: "acme/widget", htmlUrl: "https://github.com/acme/widget" },
    user: { id: "u1", email: "dev@example.com" },
  };
}

const publicDns: ResolveAll = async () => [{ address: "93.184.216.34", family: 4 }];

describe("dispatchNotification", () => {
  it.each([
    ["DISCORD_WEBHOOK", "https://discord.com/api/webhooks/1/token", "application/json"],
    ["SLACK_WEBHOOK", "https://hooks.slack.com/services/T/B/X", "application/json"],
    ["NTFY_WEBHOOK", "https://ntfy.sh/alerts", "text/markdown; charset=utf-8"],
    ["GOTIFY_WEBHOOK", "https://gotify.example.com/message?token=abc", "application/json"],
    ["CUSTOM_WEBHOOK", "https://example.com/hook", "application/json"],
  ] as const)("routes %s through the webhook sender", async (channel, url, contentType) => {
    const sendWebhook = vi.fn<WebhookSender>(async () => ({ status: 204, body: "" }));
    const result = await dispatchNotification(input(channel, url), {
      env: {},
      appBaseUrl: "https://pulse.example.com",
      sendWebhook,
    });
    expect(result.status).toBe(204);
    expect(result.destination).not.toContain("token=abc");
    const [request, options] = sendWebhook.mock.calls[0]!;
    expect(request.headers["Content-Type"]).toBe(contentType);
    expect(JSON.stringify(request)).toContain("acme/widget");
    expect(options.policy).toEqual({ mode: "none" });
  });

  it("sends email to the rule's address, or the user's email by default", async () => {
    const sendMail = vi.fn(async () => {});
    await dispatchNotification(input("EMAIL_INSTANT", null), { env: { SMTP_HOST: "smtp.example.com" }, sendMail });
    await dispatchNotification(input("EMAIL_INSTANT", "team@example.com"), { env: { SMTP_HOST: "smtp.example.com" }, sendMail });
    expect(sendMail.mock.calls.map((call) => (call as unknown as [{ to: string }])[0].to)).toEqual(["dev@example.com", "team@example.com"]);
  });

  it("fails permanently when SMTP is not configured or the channel is not deliverable", async () => {
    await expect(dispatchNotification(input("EMAIL_INSTANT", null), { env: {} })).rejects.toMatchObject({ permanent: true });
    await expect(dispatchNotification(input("IN_APP", null), { env: {} })).rejects.toMatchObject({ permanent: true });
    await expect(dispatchNotification(input("DISCORD_WEBHOOK", null), { env: {} })).rejects.toMatchObject({ permanent: true });
  });

  it("blocks a private destination before sending anything (real transport)", async () => {
    const error = await dispatchNotification(input("CUSTOM_WEBHOOK", "http://127.0.0.1:9/hook"), { env: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(WebhookUrlError);
    expect(error.permanent).toBe(true);
  });

  it("builds links from APP_BASE_URL / AUTH_URL", () => {
    expect(resolveAppBaseUrl({ APP_BASE_URL: "pulse.example.com/" })).toBe("https://pulse.example.com");
    expect(resolveAppBaseUrl({ AUTH_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
    expect(releaseReaderUrl("https://p.example", "abc")).toBe("https://p.example/?release=abc");
  });

  it("buildTestRelease is a major v1.0.0 test release", () => {
    const { release } = buildTestRelease();
    expect(release).toMatchObject({ tagName: "v1.0.0", title: "v1.0.0 - RepoPulse Test Release", semverType: "MAJOR" });
  });
});

describe("postWebhook against a local server", () => {
  let server: http.Server;
  let base: string;
  const received: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const allowAll = { mode: "all" } as const;
  const localDns: ResolveAll = async () => [{ address: "127.0.0.1", family: 4 }];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ url: req.url ?? "", headers: req.headers, body });
        if (req.url === "/ok") return void res.writeHead(204).end();
        if (req.url === "/gone") return void res.writeHead(404, { "content-type": "application/json" }).end('{"message":"Unknown Webhook","code":10015}');
        if (req.url === "/busy") return void res.writeHead(503).end("try later");
        if (req.url === "/moved") return void res.writeHead(302, { location: "http://169.254.169.254/" }).end();
        if (req.url === "/slow") return void setTimeout(() => res.writeHead(200).end(), 2_000);
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://hooks.test:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const send = (path: string, options: { timeoutMs?: number } = {}) =>
    postWebhook(
      { url: new URL(`${base}${path}`), headers: { "Content-Type": "application/json" }, body: '{"hello":"world"}', service: "Test", destination: "hooks.test" },
      { policy: allowAll, resolveAll: localDns, ...options },
    );

  it("delivers the body and headers", async () => {
    await expect(send("/ok")).resolves.toMatchObject({ status: 204 });
    const last = received.at(-1)!;
    expect(last.body).toBe('{"hello":"world"}');
    expect(last.headers["user-agent"]).toMatch(/^RepoPulse/);
    expect(last.headers["content-type"]).toBe("application/json");
  });

  it("turns credentials in the URL into a Basic Authorization header", async () => {
    await postWebhook(
      { url: new URL(base.replace("http://", "http://alice:s%40cret@") + "/ok"), headers: {}, body: "x", service: "Test", destination: "hooks.test" },
      { policy: allowAll, resolveAll: localDns },
    );
    expect(received.at(-1)!.headers.authorization).toBe(`Basic ${Buffer.from("alice:s@cret").toString("base64")}`);
  });

  it("classifies failures as permanent (4xx, redirects) or transient (5xx, timeouts)", async () => {
    const gone = (await send("/gone").catch((e: unknown) => e)) as NotificationDeliveryError;
    expect(gone).toMatchObject({ permanent: true, status: 404 });
    expect(gone.message).toBe("Test rejected the notification: HTTP 404 (Unknown Webhook).");

    await expect(send("/busy")).rejects.toMatchObject({ permanent: false, status: 503 });
    await expect(send("/moved")).rejects.toMatchObject({ permanent: true, status: 302 });
    const slow = (await send("/slow", { timeoutMs: 200 }).catch((e: unknown) => e)) as NotificationDeliveryError;
    expect(slow).toMatchObject({ permanent: false });
    expect(slow.message).toMatch(/timed out/);
  });

  it("refuses to connect when the host resolves to loopback without the opt-in", async () => {
    const before = received.length;
    await expect(
      postWebhook(
        { url: new URL(`${base}/ok`), headers: {}, body: "x", service: "Test", destination: "hooks.test" },
        { policy: { mode: "none" }, resolveAll: localDns },
      ),
    ).rejects.toBeInstanceOf(WebhookUrlError);
    expect(received.length).toBe(before);
  });

  it("checks the address again at connect time (DNS rebinding)", async () => {
    let calls = 0;
    // First answer (validation) is public, the second (socket lookup) is loopback.
    const rebinding: ResolveAll = async () => (calls++ === 0 ? publicDns("x") : localDns("x"));
    const before = received.length;
    await expect(
      postWebhook(
        { url: new URL(`${base}/ok`), headers: {}, body: "x", service: "Test", destination: "hooks.test" },
        { policy: { mode: "none" }, resolveAll: rebinding },
      ),
    ).rejects.toBeInstanceOf(WebhookUrlError);
    expect(received.length).toBe(before);
  });
});
