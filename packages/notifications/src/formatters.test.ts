import { describe, expect, it } from "vitest";
import { maskDestination } from "./channels.js";
import { formatCustomWebhookPayload } from "./formatters/custom.js";
import { DISCORD_DESCRIPTION_LIMIT, formatDiscordPayload } from "./formatters/discord.js";
import { toSmtpConfig, renderReleaseEmail } from "./formatters/email.js";
import { buildGotifyRequest, buildNtfyRequest, encodeHeaderValue, resolveGotifyEndpoint } from "./formatters/ntfy-gotify.js";
import { formatSlackPayload } from "./formatters/slack.js";
import { cleanMarkdown, githubLinkLabel, markdownToEmailHtml, releaseKindLabel, markdownToSlack, truncateBytes, truncateText } from "./markdown.js";
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

  it("encodes non-ASCII header values and keeps the body under 4096 bytes", () => {
    expect(encodeHeaderValue("Neue Version ✨")).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(encodeHeaderValue("plain")).toBe("plain");
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

  it("appends /message to a bare server URL and requires a token", () => {
    expect(resolveGotifyEndpoint("https://example.com/gotify/?token=t").url.href).toBe("https://example.com/gotify/message");
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
    expect(() => toSmtpConfig({ ...base, smtpHost: "h", smtpPort: 70000 })).toThrow(/not a valid port/);
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
  it("cleanMarkdown drops comments and tags but keeps text", () => {
    expect(cleanMarkdown("<!-- hidden -->\r\n<details><summary>More</summary>\n\nText</details>")).toBe("More\n\nText");
  });

  it("truncateText never splits surrogate pairs and prefers word boundaries", () => {
    expect(truncateText("hello world again", 13)).toBe("hello world…");
    const cut = truncateText("😀😀😀😀", 4);
    expect(cut).toBe("😀…");
    expect(truncateBytes("ééééé", 5)).toBe("é…");
  });
});

describe("maskDestination", () => {
  it.each([
    ["DISCORD_WEBHOOK", "https://discord.com/api/webhooks/123/abcdefghijkl", "discord.com/api/webhooks/123/abcd••••"],
    ["SLACK_WEBHOOK", "https://hooks.slack.com/services/T0/B0/XYZXYZXYZ", "hooks.slack.com/services/T0/B0/XYZ••••"],
    ["GOTIFY_WEBHOOK", "https://gotify.example.com/message?token=SECRET", "gotify.example.com/message?••••"],
    ["NTFY_WEBHOOK", "https://user:pass@ntfy.example.com/topic", "ntfy.example.com/t••••"],
    ["EMAIL_INSTANT", null, "Your account email"],
    ["EMAIL_INSTANT", "me@example.com", "me@example.com"],
  ])("%s %s", (channel, destination, expected) => {
    expect(maskDestination(channel, destination)).toBe(expected);
  });
});
