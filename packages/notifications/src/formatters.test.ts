import nodemailer from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import { channelLabel, maskDestination } from "./channels.js";
import { NotificationDeliveryError } from "./errors.js";
import { formatCustomWebhookPayload } from "./formatters/custom.js";
import {
  buildDependencyContext,
  dependencyHeadline,
  formatDependencyDiscordPayload,
} from "./formatters/dependencies.js";
import { DISCORD_DESCRIPTION_LIMIT, formatDiscordPayload } from "./formatters/discord.js";
import { createSmtpSender, defaultSmtpFrom, renderReleaseEmail, toSmtpConfig } from "./formatters/email.js";
import { buildGotifyRequest, buildNtfyRequest, encodeHeaderValue, resolveGotifyEndpoint } from "./formatters/ntfy-gotify.js";
import { formatSlackPayload } from "./formatters/slack.js";
import {
  cleanMarkdown,
  githubLinkLabel,
  markdownToEmailHtml,
  markdownToSlack,
  releaseKindLabel,
  releaseSummary,
  truncateBytes,
  truncateText,
} from "./markdown.js";
import type { MessageContext, SemverType } from "./types.js";

function context(overrides: { semverType?: SemverType; body?: string; tag?: { name: string; colorHex: string } | null } = {}): MessageContext {
  return {
    rule: { id: "rule1", channel: "DISCORD_WEBHOOK", destinationUrl: "https://discord.com/api/webhooks/1/x", tag: overrides.tag ?? null },
    release: {
      id: "rel1",
      tagName: "v2.0.0",
      title: "Version 2",
      bodyMarkdown: overrides.body ?? "## Breaking\n\n- Dropped **Node 18** support\n- See [docs](https://example.com/docs)",
      htmlUrl: "https://github.com/acme/widget/releases/tag/v2.0.0",
      semverType: overrides.semverType ?? "MAJOR",
      isPrerelease: false,
      publishedAt: new Date("2026-10-30T12:00:00Z"),
    },
    repository: { fullName: "acme/widget", htmlUrl: "https://github.com/acme/widget", avatarUrl: "https://avatars.example/acme.png" },
    user: { id: "u1", email: "dev@example.com" },
    appBaseUrl: "https://pulse.example.com",
    readerUrl: "https://pulse.example.com/?release=rel1",
  };
}

describe("Discord", () => {
  it("builds the embed with title, url and semver color", () => {
    const payload = formatDiscordPayload(context());
    const embed = payload.embeds[0]!;
    expect(embed.title).toBe("acme/widget v2.0.0 released");
    expect(embed.url).toBe("https://github.com/acme/widget/releases/tag/v2.0.0");
    expect(embed.color).toBe(0xef4444);
    expect(embed.description).toContain("[Read in RepoPulse](https://pulse.example.com/?release=rel1)");
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(formatDiscordPayload(context({ semverType: "MINOR" })).embeds[0]!.color).toBe(0x3b82f6);
    expect(formatDiscordPayload(context({ semverType: "PATCH" })).embeds[0]!.color).toBe(0x10b981);
  });

  it("truncates huge changelogs at 3,800 characters and keeps the RepoPulse link", () => {
    const body = "word ".repeat(5000);
    const description = formatDiscordPayload(context({ body })).embeds[0]!.description;
    expect(description.length).toBeLessThanOrEqual(DISCORD_DESCRIPTION_LIMIT);
    expect(description.indexOf("…")).toBeLessThanOrEqual(3800);
    expect(description.endsWith("[Read in RepoPulse](https://pulse.example.com/?release=rel1)")).toBe(true);
  });

  it("adds the rule's tag as a field", () => {
    const embed = formatDiscordPayload(context({ tag: { name: "Critical", colorHex: "#EF4444" } })).embeds[0]!;
    expect(embed.fields).toContainEqual({ name: "Tag", value: "Critical", inline: true });
  });
});

describe("Slack", () => {
  it("uses header, context, section and an actions block with both links", () => {
    const payload = formatSlackPayload(context());
    expect(payload.text).toBe("New release: acme/widget v2.0.0");
    expect(payload.blocks.map((b) => b.type)).toEqual(["header", "context", "section", "actions"]);
    const section = payload.blocks[2] as { text: { text: string } };
    expect(section.text.text).toContain("*Breaking*");
    expect(section.text.text).toContain("• Dropped *Node 18* support");
    expect(section.text.text).toContain("<https://example.com/docs|docs>");
    const actions = payload.blocks[3] as { elements: Array<{ url: string }> };
    expect(actions.elements.map((e) => e.url)).toEqual([
      "https://pulse.example.com/?release=rel1",
      "https://github.com/acme/widget/releases/tag/v2.0.0",
    ]);
  });

  it("escapes &, < and > outside of links", () => {
    expect(markdownToSlack("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });
});

describe("ntfy", () => {
  it("sends the markdown body with title, priority, tags and click headers", () => {
    const request = buildNtfyRequest(context(), "https://ntfy.sh/alerts");
    expect(request.url.href).toBe("https://ntfy.sh/alerts");
    expect(request.headers).toMatchObject({
      Title: "New Release: acme/widget v2.0.0",
      Priority: "high",
      Tags: "package,rocket",
      Click: "https://github.com/acme/widget/releases/tag/v2.0.0",
      Markdown: "yes",
    });
    expect(request.body).toContain("**Version 2**");
    expect(buildNtfyRequest(context({ semverType: "PATCH" }), "https://ntfy.sh/alerts").headers.Priority).toBe("default");
  });

  it("encodes non-ASCII header values, strips newlines, and keeps the body under 4096 bytes", () => {
    expect(encodeHeaderValue("Neue Version ✨")).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(encodeHeaderValue("plain")).toBe("plain");
    expect(encodeHeaderValue("line1\r\nline2\nline3")).toBe("line1 line2 line3");
    const request = buildNtfyRequest(context({ body: "🚀".repeat(3000) }), "https://ntfy.sh/alerts");
    expect(Buffer.byteLength(request.body)).toBeLessThanOrEqual(3800);
  });
});

describe("Gotify", () => {
  it("posts JSON with markdown display and priority 8 for majors", () => {
    const request = buildGotifyRequest(context(), "https://gotify.example.com/message?token=SECRET");
    expect(request.url.href).toBe("https://gotify.example.com/message");
    expect(request.headers["X-Gotify-Key"]).toBe("SECRET");
    const body = JSON.parse(request.body);
    expect(body.title).toBe("New Release: acme/widget v2.0.0");
    expect(body.priority).toBe(8);
    expect(body.extras["client::display"]).toEqual({ contentType: "text/markdown" });
    expect(JSON.parse(buildGotifyRequest(context({ semverType: "MINOR" }), "https://g.example/message?token=x").body).priority).toBe(5);
  });

  it("appends /message to a bare server URL without duplicating it, keeps other query params, and requires a token", () => {
    expect(resolveGotifyEndpoint("https://example.com/gotify/?token=t").url.href).toBe("https://example.com/gotify/message");
    expect(resolveGotifyEndpoint("https://example.com/message/?token=t&foo=bar").url.href).toBe("https://example.com/message/?foo=bar");
    expect(() => resolveGotifyEndpoint("https://gotify.example.com/message")).toThrow(/application token/);
  });
});

describe("email", () => {
  it("renders an escaped HTML email with version badge and RepoPulse button", () => {
    const email = renderReleaseEmail(context({ body: "Fixes <script>alert(1)</script> and **more**", tag: { name: "Critical", colorHex: "#EF4444" } }));
    expect(email.subject).toBe("acme/widget v2.0.0 released (major)");
    expect(email.html).toContain("Major release");
    expect(email.html).toContain('href="https://pulse.example.com/?release=rel1"');
    expect(email.html).toContain("<strong>more</strong>");
    expect(email.html).not.toContain("<script>");
    expect(email.text).toContain("Open in RepoPulse: https://pulse.example.com/?release=rel1");
  });

  it("markdownToEmailHtml escapes raw HTML and only links http(s)", () => {
    const html = markdownToEmailHtml('<img src=x onerror=alert(1)>\n[bad](javascript:alert(1)) [ok](https://example.com)');
    expect(html).not.toMatch(/<img/);
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('href="https://example.com"');
  });

  it("builds the SMTP config from the stored settings with sensible defaults", () => {
    const base = { smtpHost: null, smtpPort: 587, smtpSecure: null, smtpUser: null, smtpPassword: null, smtpFrom: null };
    expect(toSmtpConfig(null)).toBeNull();
    expect(toSmtpConfig(base)).toBeNull();
    expect(toSmtpConfig({ ...base, smtpHost: "  " })).toBeNull();
    expect(toSmtpConfig({ ...base, smtpHost: "smtp.example.com", smtpUser: "bot@example.com", smtpPassword: "x" })).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "bot@example.com",
      pass: "x",
      from: "RepoPulse <bot@example.com>",
    });
    expect(toSmtpConfig({ ...base, smtpHost: "smtp.example.com", smtpPort: 465 })?.secure).toBe(true);
    expect(toSmtpConfig({ ...base, smtpHost: "smtp.example.com", smtpPort: 465, smtpSecure: false })?.secure).toBe(false);
    expect(toSmtpConfig({ ...base, smtpHost: "h", smtpFrom: "Releases <r@example.com>" })?.from).toBe("Releases <r@example.com>");
    expect(toSmtpConfig({ ...base, smtpHost: "relay.lan" })).toMatchObject({
      user: undefined,
      pass: undefined,
      from: "RepoPulse <repopulse@relay.lan>",
    });
    // A password without a username is never sent.
    expect(toSmtpConfig({ ...base, smtpHost: "h", smtpPassword: "x" })?.pass).toBeUndefined();
    expect(defaultSmtpFrom("smtp.example.com", "apikey")).toBe("RepoPulse <repopulse@smtp.example.com>");
    for (const badPort of [0, -1, 70000, 587.5]) {
      expect(() => toSmtpConfig({ ...base, smtpHost: "h", smtpPort: badPort })).toThrow(/not a valid port/);
    }
  });

  it("reuses the SMTP transport until config changes and maps SMTP errors", async () => {
    const sendMail = vi.fn<() => Promise<void>>(async () => {});
    const close = vi.fn();
    const createSpy = vi
      .spyOn(nodemailer, "createTransport")
      .mockImplementation(() => ({ sendMail, close }) as unknown as ReturnType<typeof nodemailer.createTransport>);

    try {
      const cfg1 = { host: "smtp1.test", port: 587, secure: false, user: "u", pass: "p", from: "r@test" };
      createSmtpSender(cfg1);
      const sender1Again = createSmtpSender(cfg1);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();

      await sender1Again({ from: "r@test", to: "a@test", subject: "s", text: "t", html: "h" });
      expect(sendMail).toHaveBeenCalledTimes(1);

      const cfg2 = { ...cfg1, host: "smtp2.test" };
      const sender2 = createSmtpSender(cfg2);
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(1);

      sendMail.mockRejectedValueOnce(Object.assign(new Error("Invalid login"), { code: "EAUTH" }));
      await expect(sender2({ from: "r@test", to: "a@test", subject: "s", text: "t", html: "h" })).rejects.toMatchObject({
        name: "NotificationDeliveryError",
        permanent: true,
        message: expect.stringContaining("SMTP authentication failed"),
      });

      sendMail.mockRejectedValueOnce(Object.assign(new Error("Mailbox unavailable"), { responseCode: 550, response: "550 User unknown" }));
      await expect(sender2({ from: "r@test", to: "a@test", subject: "s", text: "t", html: "h" })).rejects.toMatchObject({
        permanent: true,
        message: expect.stringContaining("550 User unknown"),
      });

      sendMail.mockRejectedValueOnce(Object.assign(new Error("Try again"), { responseCode: 421, response: "421 Service busy" }));
      const transient = (await sender2({ from: "r@test", to: "a@test", subject: "s", text: "t", html: "h" }).catch((e: unknown) => e)) as NotificationDeliveryError;
      expect(transient).toBeInstanceOf(NotificationDeliveryError);
      expect(transient.permanent).toBe(false);

      sendMail.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
      await expect(sender2({ from: "r@test", to: "a@test", subject: "s", text: "t", html: "h" })).rejects.toMatchObject({
        permanent: false,
      });
    } finally {
      createSpy.mockRestore();
    }
  });
});

describe("custom webhook", () => {
  it("sends a stable JSON shape", () => {
    const payload = formatCustomWebhookPayload({ ...context(), test: true });
    expect(payload).toMatchObject({
      event: "release.published",
      test: true,
      repository: { fullName: "acme/widget" },
      release: { tagName: "v2.0.0", semverType: "MAJOR", source: "RELEASE", publishedAt: "2026-10-30T12:00:00.000Z" },
      links: { repopulse: "https://pulse.example.com/?release=rel1" },
    });
  });
});

describe("commit notifications", () => {
  const commit = (): MessageContext => {
    const ctx = context({ semverType: "OTHER" });
    return {
      ...ctx,
      release: { ...ctx.release, source: "COMMIT", tagName: "0123456", title: "fix(db): index", htmlUrl: "https://github.com/acme/widget/commit/0123456" },
    };
  };

  it("say commit instead of release", () => {
    expect(releaseKindLabel({ source: "COMMIT", semverType: "OTHER" })).toBe("Commit");
    expect(githubLinkLabel({ source: "COMMIT" })).toBe("View commit on GitHub");
    expect(formatDiscordPayload(commit()).embeds[0]!.title).toBe("acme/widget: new commit 0123456");
    expect(formatSlackPayload(commit()).text).toBe("New commit: acme/widget 0123456");
    expect(formatCustomWebhookPayload(commit()).release.source).toBe("COMMIT");
  });
});

describe("markdown helpers", () => {
  it("cleanMarkdown drops comments and tags but keeps text, and releaseSummary falls back when empty", () => {
    expect(cleanMarkdown("<!-- hidden -->\r\n<details><summary>More</summary>\n\nText</details>")).toBe("More\n\nText");
    expect(releaseSummary({ ...context().release, bodyMarkdown: "<!-- only comment -->   " })).toBe(
      "_No release notes were published for this version._",
    );
  });

  it("formats releaseKindLabel and githubLinkLabel across sources and semver types", () => {
    expect(releaseKindLabel({ source: "TAG", semverType: "OTHER" })).toBe("Git tag");
    expect(releaseKindLabel({ source: "TAG", semverType: "MAJOR" })).toBe("Major tag");
    expect(releaseKindLabel({ source: "RELEASE", semverType: "PRERELEASE" })).toBe("Pre-release");
    expect(githubLinkLabel({ source: "TAG" })).toBe("View on GitHub");
    expect(githubLinkLabel({ source: "RELEASE" })).toBe("Release notes on GitHub");
  });

  it("converts fenced code, images, strikethrough and quotes in markdownToSlack and markdownToEmailHtml", () => {
    const slack = markdownToSlack("```ts\nconst x = a < b && c > d;\n```\n![logo](https://x.io/a.png)\n![](https://x.io/b.png)\n~~old~~\n> quote");
    expect(slack).toContain("```const x = a &lt; b &amp;&amp; c &gt; d;```");
    expect(slack).toContain("<https://x.io/a.png|logo>");
    expect(slack).toContain("<https://x.io/b.png|image>");
    expect(slack).toContain("~old~");
    expect(slack).toContain("> quote");

    const emailHtml = markdownToEmailHtml(
      "# H1\n### H3\n1. first\n2) second\n> quoted\n`code` and *italic*\n```js\nunclosed <tag>",
    );
    expect(emailHtml).toContain("font-size:17px");
    expect(emailHtml).toContain("font-size:15px");
    expect(emailHtml).toContain("<li");
    expect(emailHtml).toContain("<blockquote");
    expect(emailHtml).toContain("<code");
    expect(emailHtml).toContain("<em>italic</em>");
    expect(emailHtml).toContain("unclosed &lt;tag&gt;</code></pre>");
  });

  it("truncateText and truncateBytes never split surrogate pairs or multi-byte characters", () => {
    expect(truncateText("hello world again", 13)).toBe("hello world…");
    const cut = truncateText("😀😀😀😀", 4);
    expect(cut).toBe("😀…");
    expect(truncateBytes("ééééé", 5)).toBe("é…");
    const emojiBytes = truncateBytes("🚀".repeat(10), 10);
    expect(Buffer.byteLength(emojiBytes, "utf8")).toBeLessThanOrEqual(10);
    expect(emojiBytes).not.toContain("\uFFFD");
  });
});

describe("channels & maskDestination", () => {
  it.each([
    ["DISCORD_WEBHOOK", "https://discord.com/api/webhooks/123/abcdefghijkl", "discord.com/api/webhooks/123/abcd••••"],
    ["SLACK_WEBHOOK", "https://hooks.slack.com/services/T0/B0/XYZXYZXYZ", "hooks.slack.com/services/T0/B0/XYZ••••"],
    ["GOTIFY_WEBHOOK", "https://gotify.example.com/message?token=SECRET", "gotify.example.com/message?••••"],
    ["NTFY_WEBHOOK", "https://user:pass@ntfy.example.com/topic", "ntfy.example.com/t••••"],
    ["NTFY_WEBHOOK", "https://ntfy.example.com/ab", "ntfy.example.com/••••"],
    ["CUSTOM_WEBHOOK", "https://example.com/", "example.com"],
    ["CUSTOM_WEBHOOK", "not a url", "Invalid URL"],
    ["DISCORD_WEBHOOK", null, "—"],
    ["EMAIL_INSTANT", null, "Your account email"],
    ["EMAIL_INSTANT", "me@example.com", "me@example.com"],
    ["EMAIL_DIGEST", "digest@example.com", "digest@example.com"],
  ])("%s %s", (channel, destination, expected) => {
    expect(maskDestination(channel, destination)).toBe(expected);
  });

  it("returns human labels for known and unknown channels", () => {
    expect(channelLabel("DISCORD_WEBHOOK")).toBe("Discord");
    expect(channelLabel("IN_APP")).toBe("In-app");
    expect(channelLabel("EMAIL_DIGEST")).toBe("Email digest");
    expect(channelLabel("CUSTOM_UNKNOWN")).toBe("CUSTOM_UNKNOWN");
  });
});

describe("dependency formatter edge cases", () => {
  it("handles empty updates, strips backticks in package names, and formats PR headline without number", () => {
    const emptyCtx = buildDependencyContext(
      {
        project: { fullName: "acme/widget", url: "https://pulse.example.com/dependencies/acme/widget" },
        kind: "digest",
        updates: [],
        rule: { channel: "DISCORD_WEBHOOK", destinationUrl: "https://discord.com/api/webhooks/1/x" },
      },
      "https://pulse.example.com",
    );
    expect(emptyCtx.highest).toBe("OTHER");
    expect(emptyCtx.hasMajor).toBe(false);
    expect(emptyCtx.total).toBe(0);
    expect(formatDependencyDiscordPayload(emptyCtx).embeds[0]!.fields).toEqual([]);

    const backtickCtx = buildDependencyContext(
      {
        project: { fullName: "acme/widget", url: "https://pulse.example.com/dependencies/acme/widget" },
        kind: "pull_request",
        updates: [{ name: "bad`pkg\nname", from: "1.0.0", to: "2.0.0", level: null, manifest: "package.json" }],
        pullRequest: { event: "opened", number: null },
        rule: { channel: "DISCORD_WEBHOOK", destinationUrl: "https://discord.com/api/webhooks/1/x" },
      },
      "https://pulse.example.com",
    );
    expect(dependencyHeadline(backtickCtx)).toBe("acme/widget: pull request opened");
    const desc = formatDependencyDiscordPayload(backtickCtx).embeds[0]!.description;
    expect(desc).toContain("- `badpkgname` 1.0.0 → 2.0.0 · Other · package.json");
  });
});
