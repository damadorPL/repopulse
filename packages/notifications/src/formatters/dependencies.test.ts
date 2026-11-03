import { describe, expect, it } from "vitest";
import { DISCORD_COLORS } from "./discord.js";
import {
  buildDependencyContext,
  buildDependencyGotifyRequest,
  buildDependencyNtfyRequest,
  dependencyHeadline,
  DIGEST_MAX_ITEMS,
  formatDependencyDiscordPayload,
  formatDependencyGotifyMessage,
  formatDependencySlackPayload,
  formatDependencyWebhookPayload,
  renderDependencyEmail,
  type DependencyNotificationInput,
  type DependencyUpdateInput,
} from "./dependencies.js";

const PROJECT_URL = "https://pulse.example.com/dependencies/acme/widget";
const BASE = "https://pulse.example.com";

const UPDATES: DependencyUpdateInput[] = [
  { name: "typing_extensions", from: "4.12.0", to: "4.13.1", level: "MINOR", manifest: "requirements.txt", ecosystem: "PYPI" },
  { name: "react", from: "18.3.1", to: "19.3.0", level: "MAJOR", manifest: "package.json", ecosystem: "NPM" },
  { name: "lodash", from: null, to: "4.17.22", level: "PATCH", manifest: "apps/web/package.json" },
];

function digest(updates = UPDATES, extra: Partial<DependencyNotificationInput> = {}) {
  return buildDependencyContext(
    {
      project: { fullName: "acme/widget", url: PROJECT_URL, htmlUrl: "https://github.com/acme/widget" },
      kind: "digest",
      updates,
      rule: { id: "rule1", channel: "DISCORD_WEBHOOK", destinationUrl: "https://discord.com/api/webhooks/1/x" },
      ...extra,
    },
    BASE,
  );
}

function pullRequest(event: "opened" | "updated" | "edited" | "access_lost", updates = UPDATES.slice(0, 1)) {
  return digest(updates, {
    kind: "pull_request",
    pullRequest:
      event === "access_lost"
        ? { event }
        : { event, number: 12, url: "https://github.com/acme/widget/pull/12", title: "chore(deps): update typing_extensions to 4.13.1" },
  });
}

function many(count: number): DependencyUpdateInput[] {
  return Array.from({ length: count }, (_, i) => ({ name: `pkg-${i}`, from: "1.0.0", to: "1.1.0", level: "MINOR" as const, manifest: "package.json" }));
}

describe("buildDependencyContext", () => {
  it("sorts by level, finds the highest level and the major flag", () => {
    const ctx = digest();
    expect(ctx.shown.map((u) => u.name)).toEqual(["react", "typing_extensions", "lodash"]);
    expect(ctx.highest).toBe("MAJOR");
    expect(ctx.hasMajor).toBe(true);
    expect(ctx.event).toBe("dependencies.outdated");
    expect(pullRequest("opened").event).toBe("dependencies.pull_request");
  });

  it(`lists at most ${DIGEST_MAX_ITEMS} updates and counts the rest`, () => {
    const ctx = digest(many(30));
    expect(ctx.shown).toHaveLength(25);
    expect(ctx.more).toBe(5);
    // The caller may have cut the list already.
    const cut = digest(many(3), { totalUpdates: 40 });
    expect(cut.total).toBe(40);
    expect(cut.more).toBe(37);
  });

  it("writes headlines per event", () => {
    expect(dependencyHeadline(digest())).toBe("acme/widget: 3 outdated dependencies");
    expect(dependencyHeadline(digest(UPDATES.slice(0, 1)))).toBe("acme/widget: 1 outdated dependency");
    expect(dependencyHeadline(pullRequest("opened"))).toBe("acme/widget: pull request #12 opened");
    expect(dependencyHeadline(pullRequest("updated"))).toBe("acme/widget: pull request #12 updated");
    expect(dependencyHeadline(pullRequest("edited"))).toBe("acme/widget: pull request #12 was changed by someone else");
    expect(dependencyHeadline(pullRequest("access_lost", []))).toBe("acme/widget: dependency pull requests paused");
  });
});

describe("Discord", () => {
  it("colors the embed by the highest level and links to the project page", () => {
    const payload = formatDependencyDiscordPayload(digest(), new Date("2026-11-03T00:00:00Z"));
    const embed = payload.embeds[0]!;
    expect(embed.color).toBe(DISCORD_COLORS.MAJOR);
    expect(embed.url).toBe(PROJECT_URL);
    expect(embed.description).toContain("- `react` 18.3.1 → 19.3.0 · Major · package.json");
    expect(embed.description).toContain("`typing_extensions`");
    expect(embed.description).toContain("- `lodash` → 4.17.22 · Patch");
    expect(embed.description).toContain(`[Open in RepoPulse](${PROJECT_URL})`);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(formatDependencyDiscordPayload(digest(UPDATES.slice(2))).embeds[0]!.color).toBe(DISCORD_COLORS.PATCH);
  });

  it("adds 'and N more', the PR link, and amber for PR warnings", () => {
    expect(formatDependencyDiscordPayload(digest(many(27))).embeds[0]!.description).toContain("… and 2 more");
    const opened = formatDependencyDiscordPayload(pullRequest("opened")).embeds[0]!;
    expect(opened.description).toContain("[View pull request #12](https://github.com/acme/widget/pull/12)");
    expect(formatDependencyDiscordPayload(pullRequest("edited")).embeds[0]!.color).toBe(DISCORD_COLORS.PRERELEASE);
  });

  it("stays within Discord's description limit", () => {
    const long = many(25).map((u) => ({ ...u, name: `${u.name}-${"x".repeat(200)}` }));
    expect(formatDependencyDiscordPayload(digest(long)).embeds[0]!.description.length).toBeLessThanOrEqual(4096);
  });
});

describe("Slack", () => {
  it("builds blocks with escaped names and buttons", () => {
    const payload = formatDependencySlackPayload(
      digest([{ name: "<script>&co", from: "1", to: "2", level: "MAJOR", manifest: "package.json" }, ...many(26)]),
    );
    expect(payload.text).toBe("acme/widget: 27 outdated dependencies");
    const json = JSON.stringify(payload.blocks);
    expect(json).toContain("&lt;script&gt;&amp;co");
    expect(json).not.toContain("<script>");
    expect(json).toContain("_… and 2 more_");
    const actions = payload.blocks.at(-1);
    expect(actions).toMatchObject({ type: "actions", elements: [{ url: PROJECT_URL }] });
  });

  it("adds the PR button and the event explanation", () => {
    const payload = formatDependencySlackPayload(pullRequest("edited"));
    expect(JSON.stringify(payload.blocks)).toContain("no longer updates it");
    expect(payload.blocks.at(-1)).toMatchObject({ elements: [{ action_id: "open_repopulse" }, { action_id: "open_pull_request" }] });
  });
});

describe("ntfy / Gotify", () => {
  it("ntfy: high priority with a major update, Markdown body, click to the project page", () => {
    const request = buildDependencyNtfyRequest(digest(), "https://ntfy.sh/deps");
    expect(request.headers.Priority).toBe("high");
    expect(request.headers.Click).toBe(PROJECT_URL);
    expect(request.headers.Markdown).toBe("yes");
    expect(request.headers.Title).toBe("acme/widget: 3 outdated dependencies");
    expect(request.body).toContain("`react` 18.3.1 → 19.3.0");
    expect(buildDependencyNtfyRequest(digest(UPDATES.slice(0, 1)), "https://ntfy.sh/deps").headers.Priority).toBe("default");
    expect(buildDependencyNtfyRequest(pullRequest("opened"), "https://ntfy.sh/deps").headers.Actions).toContain(
      "view, View pull request, https://github.com/acme/widget/pull/12",
    );
  });

  it("ntfy: keeps the body under 4096 bytes", () => {
    const long = many(25).map((u) => ({ ...u, name: `${u.name}-${"ü".repeat(200)}` }));
    expect(Buffer.byteLength(buildDependencyNtfyRequest(digest(long), "https://ntfy.sh/deps").body)).toBeLessThanOrEqual(3800);
  });

  it("Gotify: priority 8 with a major, the token moves to a header", () => {
    expect(formatDependencyGotifyMessage(digest()).priority).toBe(8);
    expect(formatDependencyGotifyMessage(digest(UPDATES.slice(0, 1))).priority).toBe(5);
    const request = buildDependencyGotifyRequest(digest(), "https://gotify.example.com?token=abc");
    expect(request.url.href).toBe("https://gotify.example.com/message");
    expect(request.headers["X-Gotify-Key"]).toBe("abc");
    const body = JSON.parse(request.body) as { message: string; extras: { "client::notification": { click: { url: string } } } };
    expect(body.message).toContain(`[Open in RepoPulse](${PROJECT_URL})`);
    expect(body.extras["client::notification"].click.url).toBe(PROJECT_URL);
  });
});

describe("custom webhook", () => {
  it("emits dependencies.outdated with the capped list and the total", () => {
    const payload = formatDependencyWebhookPayload(digest([...UPDATES, ...many(30)]));
    expect(payload.event).toBe("dependencies.outdated");
    expect(payload.updates).toHaveLength(25);
    expect(payload.totalUpdates).toBe(33);
    expect(payload.updates[0]).toEqual({ name: "react", from: "18.3.1", to: "19.3.0", level: "MAJOR", manifest: "package.json", ecosystem: "NPM" });
    expect(payload.repository).toEqual({ fullName: "acme/widget", htmlUrl: "https://github.com/acme/widget" });
    expect(payload.pullRequest).toBeNull();
    expect(payload.links).toEqual({ repopulse: PROJECT_URL, pullRequest: null });
  });

  it("emits dependencies.pull_request with the PR", () => {
    const payload = formatDependencyWebhookPayload(pullRequest("updated"));
    expect(payload.event).toBe("dependencies.pull_request");
    expect(payload.pullRequest).toEqual({
      event: "updated",
      number: 12,
      url: "https://github.com/acme/widget/pull/12",
      title: "chore(deps): update typing_extensions to 4.13.1",
    });
    expect(formatDependencyWebhookPayload(pullRequest("access_lost", [])).pullRequest).toEqual({
      event: "access_lost",
      number: null,
      url: null,
      title: null,
    });
  });
});

describe("email", () => {
  it("renders an escaped HTML table and a text part", () => {
    const email = renderDependencyEmail(
      digest([{ name: "<b>evil</b>", from: "1.0.0", to: "2.0.0", level: "MAJOR", manifest: "package.json" }, ...many(26)]),
    );
    expect(email.subject).toBe("acme/widget: 27 outdated dependencies (major)");
    expect(email.html).toContain("&lt;b&gt;evil&lt;/b&gt;");
    expect(email.html).not.toContain("<b>evil</b>");
    expect(email.html).toContain("<th");
    expect(email.html).toContain("… and 2 more");
    expect(email.html).toContain(PROJECT_URL);
    expect(email.text).toContain("- <b>evil</b> 1.0.0 → 2.0.0 (Major) in package.json");
    expect(email.text).toContain(`Open in RepoPulse: ${PROJECT_URL}`);
    expect(email.text).toContain("https://pulse.example.com/settings/notifications");
  });

  it("explains PR events", () => {
    const email = renderDependencyEmail(pullRequest("access_lost", []));
    expect(email.subject).toBe("acme/widget: dependency pull requests paused");
    expect(email.text).toContain("switched to notify-only");
    expect(email.html).not.toContain("<th");
  });
});
