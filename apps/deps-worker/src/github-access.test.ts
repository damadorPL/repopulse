import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubAppKeyUnreadableError } from "@repopulse/db";
import { GitHubAppAuthError, GitHubAppInstallationError } from "@repopulse/github";
import { GitHubAccess, PRIVATE_WITHOUT_APP_MESSAGE, TOKEN_REFRESH_MARGIN_MS } from "./github-access";

const APP = { appId: 1, slug: "repopulse", clientId: null, owner: null, privateKey: "PEM", webhookSecret: null };
const PROJECT = { owner: "acme", name: "widget", githubRepoId: 42, isPrivate: false };
const USER = { id: "u1", githubAccessTokenEncrypted: "enc" };

function setup(options: { app?: typeof APP | null | Error; installed?: boolean; tokenError?: Error } = {}) {
  let clock = 1_000_000;
  let issued = 0;
  const createInstallationToken = vi.fn(async (_auth: unknown, _id: number, opts: { repositoryIds: number[]; permissions: Record<string, string> }) => {
    if (options.tokenError) throw options.tokenError;
    issued++;
    void opts;
    return { token: `ghs_secret_${issued}`, expiresAt: new Date(clock + 60 * 60_000) };
  });
  const access = new GitHubAccess({
    loadApp: async () => {
      if (options.app instanceof Error) throw options.app;
      return options.app === undefined ? APP : options.app;
    },
    github: {
      createAppOctokit: vi.fn(() => ({}) as never),
      getRepoInstallation: vi.fn(async () => (options.installed === false ? null : { installationId: 7, accountLogin: "acme" })),
      createInstallationToken: createInstallationToken as never,
    },
    decrypt: (value) => {
      if (value === "corrupt") throw new Error("bad key");
      return `gho_${value}`;
    },
    now: () => clock,
  });
  return { access, createInstallationToken, tick: (ms: number) => (clock += ms) };
}

afterEach(() => vi.restoreAllMocks());

describe("GitHubAccess", () => {
  it("caches installation tokens until 5 minutes before expiry, per repository and scope", async () => {
    const { access, createInstallationToken, tick } = setup();
    const app = (await access.app())!;
    expect(await access.installationToken(app, 7, 42, "read")).toBe("ghs_secret_1");
    expect(await access.installationToken(app, 7, 42, "read")).toBe("ghs_secret_1");
    expect(await access.installationToken(app, 7, 42, "write")).toBe("ghs_secret_2");
    expect(createInstallationToken.mock.calls[0]![2]).toEqual({ repositoryIds: [42], permissions: { contents: "read", pull_requests: "read" } });
    expect(createInstallationToken.mock.calls[1]![2]).toEqual({ repositoryIds: [42], permissions: { contents: "write", pull_requests: "write" } });

    tick(60 * 60_000 - TOKEN_REFRESH_MARGIN_MS - 1);
    expect(await access.installationToken(app, 7, 42, "read")).toBe("ghs_secret_1");
    tick(2);
    expect(await access.installationToken(app, 7, 42, "read")).toBe("ghs_secret_3");

    access.invalidate(7);
    expect(access.cachedTokenCount).toBe(0);
  });

  it("uses only the installation token when the App is installed", async () => {
    const { access } = setup();
    expect(await access.readAccess({ ...PROJECT, isPrivate: true }, USER)).toMatchObject({
      kind: "ok",
      installationId: 7,
      candidates: [{ source: "app", token: "ghs_secret_1" }],
    });
  });

  it("falls back to the owner's OAuth token, then anonymous", async () => {
    const { access } = setup({ installed: false });
    expect(await access.readAccess(PROJECT, USER)).toMatchObject({
      kind: "ok",
      installationId: null,
      candidates: [
        { source: "oauth", token: "gho_enc" },
        { source: "anonymous", token: undefined },
      ],
    });
    const noApp = setup({ app: null });
    expect(await noApp.access.readAccess(PROJECT, { id: "u1", githubAccessTokenEncrypted: "corrupt" })).toMatchObject({
      candidates: [{ source: "anonymous", token: undefined }],
    });
  });

  it("refuses a private repository without the App (no retry, user-safe message)", async () => {
    for (const ctx of [setup({ app: null }), setup({ installed: false }), setup({ tokenError: new GitHubAppInstallationError("lacks permissions", 422) })]) {
      expect(await ctx.access.readAccess({ ...PROJECT, isPrivate: true }, USER)).toEqual({ kind: "private-without-app", message: PRIVATE_WITHOUT_APP_MESSAGE });
    }
  });

  it("treats an undecryptable App key as no App", async () => {
    const { access } = setup({ app: new GitHubAppKeyUnreadableError() });
    expect(await access.app()).toBeNull();
  });

  it("handles strict vs non-strict installation() on GitHubAppAuthError and recreates appOctokit on key rotation", async () => {
    let privateKey = "PEM-1";
    const createAppOctokit = vi.fn(() => ({}) as never);
    const getRepoInstallation = vi.fn(async () => {
      if (privateKey === "BAD") throw new GitHubAppAuthError("bad key");
      return { installationId: 9, accountLogin: "acme" };
    });
    const access = new GitHubAccess({
      loadApp: async () => ({ ...APP, privateKey }),
      github: {
        createAppOctokit,
        getRepoInstallation,
        createInstallationToken: vi.fn() as never,
      },
    });

    const app1 = (await access.app())!;
    expect(await access.installation(app1, "acme", "widget")).toBe(9);
    expect(await access.installation(app1, "acme", "widget")).toBe(9);
    expect(createAppOctokit).toHaveBeenCalledTimes(1);

    // Key rotation creates a new App Octokit and evicts the previous one
    privateKey = "PEM-2";
    const app2 = (await access.app())!;
    expect(await access.installation(app2, "acme", "widget")).toBe(9);
    expect(createAppOctokit).toHaveBeenCalledTimes(2);

    // GitHubAppAuthError: returns null when strict is false/omitted, rethrows when strict is true
    privateKey = "BAD";
    const appBad = (await access.app())!;
    expect(await access.installation(appBad, "acme", "widget")).toBeNull();
    await expect(access.installation(appBad, "acme", "widget", { strict: true })).rejects.toBeInstanceOf(GitHubAppAuthError);
  });

  it("never logs tokens", async () => {
    const lines: string[] = [];
    for (const method of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    }
    const { access } = setup();
    await access.readAccess(PROJECT, USER);
    await access.readAccess({ ...PROJECT, isPrivate: true }, { id: "u1", githubAccessTokenEncrypted: "corrupt" });
    const noApp = setup({ installed: false });
    await noApp.access.readAccess(PROJECT, USER);
    expect(lines.join("\n")).not.toMatch(/ghs_secret|gho_/);
  });
});
