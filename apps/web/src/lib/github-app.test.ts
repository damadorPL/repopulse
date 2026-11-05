import { describe, expect, it } from "vitest";
import {
  callbackErrorMessage,
  enableGitHubAppWebhooksInput,
  GITHUB_APP_CALLBACK_ERRORS,
  githubAppPublicUrl,
  githubAppSettingsUrl,
  githubAppWebhookSettingsUrls,
  githubAppWebhookTarget,
} from "./github-app";

describe("githubAppWebhookTarget", () => {
  it.each([
    ["https://pulse.example.com", "https://pulse.example.com/api/github-app/webhook"],
    ["https://pulse.example.com/", "https://pulse.example.com/api/github-app/webhook"],
    ["https://example.org/repopulse/", "https://example.org/repopulse/api/github-app/webhook"],
    ["https://8.8.8.8:8443", "https://8.8.8.8:8443/api/github-app/webhook"],
  ])("offers %s", (base, url) => {
    expect(githubAppWebhookTarget(base)).toEqual({ url, reason: null });
  });

  it.each([
    "http://pulse.example.com",
    "https://localhost:3000",
    "https://app.localhost",
    "https://127.0.0.1",
    "https://10.0.0.5",
    "https://172.20.1.1",
    "https://192.168.1.20",
    "https://169.254.169.254",
    "https://[::1]:3000",
    "https://repopulse",
    "https://repopulse.internal",
    "https://nas.local",
    "not a url",
  ])("refuses %s with a reason", (base) => {
    const target = githubAppWebhookTarget(base);
    expect(target.url).toBeNull();
    expect(target.reason).toBeTruthy();
  });
});

describe("enableGitHubAppWebhooksInput", () => {
  it("defaults rotateSecret to false and rejects unknown fields", () => {
    expect(enableGitHubAppWebhooksInput.parse({})).toEqual({ rotateSecret: false });
    expect(enableGitHubAppWebhooksInput.safeParse({ secret: "x" }).success).toBe(false);
  });
});

describe("githubAppWebhookSettingsUrls", () => {
  it("links the App's general, events and advanced settings", () => {
    expect(githubAppWebhookSettingsUrls("https://github.com/settings/apps/repopulse")).toEqual({
      general: "https://github.com/settings/apps/repopulse",
      events: "https://github.com/settings/apps/repopulse/permissions",
      advanced: "https://github.com/settings/apps/repopulse/advanced",
    });
  });
});

describe("callbackErrorMessage", () => {
  it("returns null for undefined/empty, maps known error codes, and falls back to unknown", () => {
    expect(callbackErrorMessage(undefined)).toBeNull();
    expect(callbackErrorMessage("")).toBeNull();
    expect(callbackErrorMessage("state")).toBe(GITHUB_APP_CALLBACK_ERRORS.state);
    expect(callbackErrorMessage("rate_limited")).toBe(GITHUB_APP_CALLBACK_ERRORS.rate_limited);
    expect(callbackErrorMessage("unexpected_code")).toBe(GITHUB_APP_CALLBACK_ERRORS.unknown);
  });
});

describe("githubAppPublicUrl and githubAppSettingsUrl", () => {
  it("builds public and personal/organization settings URLs", () => {
    expect(githubAppPublicUrl("repopulse-app")).toBe("https://github.com/apps/repopulse-app");
    expect(githubAppSettingsUrl("repopulse-app", "alice", false)).toBe(
      "https://github.com/settings/apps/repopulse-app",
    );
    expect(githubAppSettingsUrl("repopulse-app", "acme-org", true)).toBe(
      "https://github.com/organizations/acme-org/settings/apps/repopulse-app",
    );
    expect(githubAppSettingsUrl("repopulse-app", null, true)).toBe(
      "https://github.com/settings/apps/repopulse-app",
    );
  });
});
