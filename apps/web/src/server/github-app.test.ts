import { beforeEach, describe, expect, it, vi } from "vitest";

class GitHubRateLimitError extends Error {}

vi.mock("@repopulse/db", () => ({
  prisma: { instanceSettings: { upsert: vi.fn() } },
  INSTANCE_SETTINGS_ID: 1,
  encryptToken: (value: string) => `enc(${value})`,
}));
vi.mock("@repopulse/github", () => ({ GitHubRateLimitError }));

const { completeManifestCallback, createManifestState, statesMatch } = await import("./github-app");

const APP = {
  id: 42,
  slug: "repopulse-test",
  name: "RepoPulse (test)",
  clientId: "Iv1.abc",
  clientSecret: "client-secret",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----",
  webhookSecret: "hook-secret",
  owner: "admin",
  htmlUrl: "https://github.com/apps/repopulse-test",
};

const convert = vi.fn();
const save = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  convert.mockResolvedValue(APP);
  save.mockResolvedValue(undefined);
});

describe("statesMatch", () => {
  it("matches only identical, non-empty values", () => {
    const state = createManifestState();
    expect(statesMatch(state, state)).toBe(true);
    expect(statesMatch(state, `${state}x`)).toBe(false);
    expect(statesMatch(state, "short")).toBe(false);
    expect(statesMatch(undefined, state)).toBe(false);
    expect(statesMatch(state, null)).toBe(false);
    expect(statesMatch("", "")).toBe(false);
  });

  it("creates unguessable states", () => {
    expect(createManifestState()).not.toBe(createManifestState());
    expect(createManifestState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("completeManifestCallback", () => {
  it("exchanges the code and stores the App when the state matches", async () => {
    const target = await completeManifestCallback({ code: "abc123", state: "s1", cookieState: "s1" }, { convert, save });
    expect(target).toBe("/admin/github-app?created=1");
    expect(convert).toHaveBeenCalledWith("abc123");
    expect(save).toHaveBeenCalledWith(APP);
  });

  it.each([
    ["no cookie", { code: "abc", state: "s1", cookieState: undefined }],
    ["no state", { code: "abc", state: null, cookieState: "s1" }],
    ["a different state", { code: "abc", state: "s2", cookieState: "s1" }],
  ])("refuses %s without calling GitHub", async (_label, input) => {
    expect(await completeManifestCallback(input, { convert, save })).toBe("/admin/github-app?error=state");
    expect(convert).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("needs a code", async () => {
    expect(await completeManifestCallback({ code: " ", state: "s1", cookieState: "s1" }, { convert, save })).toBe("/admin/github-app?error=code");
    expect(convert).not.toHaveBeenCalled();
  });

  it("maps failures to fixed error codes, never to GitHub's message", async () => {
    convert.mockRejectedValueOnce(new Error("secret details"));
    expect(await completeManifestCallback({ code: "abc", state: "s1", cookieState: "s1" }, { convert, save })).toBe(
      "/admin/github-app?error=conversion",
    );
    convert.mockRejectedValueOnce(new GitHubRateLimitError("rate limited"));
    expect(await completeManifestCallback({ code: "abc", state: "s1", cookieState: "s1" }, { convert, save })).toBe(
      "/admin/github-app?error=rate_limited",
    );
    save.mockRejectedValueOnce(new Error("db down"));
    expect(await completeManifestCallback({ code: "abc", state: "s1", cookieState: "s1" }, { convert, save })).toBe(
      "/admin/github-app?error=unknown",
    );
  });
});
