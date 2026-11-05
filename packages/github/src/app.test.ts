import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  appManifestFormUrl,
  buildAppManifest,
  convertAppManifest,
  createInstallationToken,
  defaultAppName,
  getAuthenticatedApp,
  getCollaboratorPermission,
  getRepoInstallation,
  getUserLoginById,
  GitHubAppAuthError,
  GitHubAppInstallationError,
  installUrl,
  permissionAtLeast,
  rethrowAppError,
} from "./app.js";
import { createOctokit } from "./client.js";
import { GitHubRateLimitError } from "./poller.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const AUTH = { appId: 4242, privateKey };

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...init.headers },
  });
}

function fakeFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function jwtPayload(authorization: string | undefined): Record<string, unknown> {
  const token = authorization?.replace(/^bearer /i, "") ?? "";
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

const APP = {
  id: 4242,
  slug: "repopulse-pulse-example-com",
  name: "RepoPulse (pulse.example.com)",
  client_id: "Iv23abc",
  owner: { login: "acme" },
  html_url: "https://github.com/apps/repopulse-pulse-example-com",
};

describe("getAuthenticatedApp", () => {
  it("calls GET /app with a JWT issued for the App id", async () => {
    const { fetch, calls } = fakeFetch(() => json(APP));
    const app = await getAuthenticatedApp(AUTH, { fetch });
    expect(app).toEqual({
      id: 4242,
      slug: "repopulse-pulse-example-com",
      name: "RepoPulse (pulse.example.com)",
      clientId: "Iv23abc",
      owner: "acme",
      htmlUrl: "https://github.com/apps/repopulse-pulse-example-com",
    });
    expect(calls[0]?.url.pathname).toBe("/app");
    expect(calls[0]?.headers.authorization).toMatch(/^bearer /i);
    expect(jwtPayload(calls[0]?.headers.authorization).iss).toBe(4242);
  });

  it("accepts a key with escaped line breaks (environment variables)", async () => {
    const { fetch } = fakeFetch(() => json(APP));
    const escaped = privateKey.replace(/\n/g, "\\n");
    await expect(getAuthenticatedApp({ appId: 4242, privateKey: escaped }, { fetch })).resolves.toMatchObject({ id: 4242 });
  });

  it("rejects a bad key without echoing it, before any request", async () => {
    const { fetch } = fakeFetch(() => json(APP));
    const secret = "-----BEGIN RSA PRIVATE KEY-----\nTOP-SECRET-MATERIAL\n-----END RSA PRIVATE KEY-----";
    const error = await getAuthenticatedApp({ appId: 1, privateKey: secret }, { fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubAppAuthError);
    expect(String((error as Error).message)).not.toContain("TOP-SECRET");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps 401 and 404 to GitHubAppAuthError without leaking the key or JWT", async () => {
    for (const status of [401, 404]) {
      const { fetch, calls } = fakeFetch(() => json({ message: "A JSON web token could not be decoded" }, { status }));
      const error = await getAuthenticatedApp(AUTH, { fetch }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitHubAppAuthError);
      const message = (error as Error).message;
      expect(message).not.toContain("PRIVATE KEY");
      expect(message).not.toContain(calls[0]?.headers.authorization?.slice(7, 40) ?? "unreachable");
    }
  });

  it("rejects an invalid App id and redacts non-HTTP signing errors in rethrowAppError", async () => {
    for (const badId of [0, -5, 1.5, Number.NaN]) {
      await expect(getAuthenticatedApp({ appId: badId, privateKey })).rejects.toBeInstanceOf(GitHubAppAuthError);
    }

    const signingErr = (() => {
      try {
        rethrowAppError(new Error("signer leaked Material-XYZ"));
      } catch (e) {
        return e;
      }
    })();
    expect(signingErr).toBeInstanceOf(GitHubAppAuthError);
    expect((signingErr as Error).message).not.toContain("Material-XYZ");
    expect((signingErr as Error).cause).toBeUndefined();
  });
});

describe("convertAppManifest", () => {
  it("posts the code unauthenticated and maps the secrets", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ ...APP, client_secret: "shh", pem: "-----BEGIN RSA PRIVATE KEY-----…", webhook_secret: null }, { status: 201 }),
    );
    const converted = await convertAppManifest("abc123", { fetch });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/app-manifests/abc123/conversions");
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(converted).toMatchObject({ id: 4242, slug: APP.slug, clientId: "Iv23abc", clientSecret: "shh", webhookSecret: null, owner: "acme" });
  });

  it("explains an expired, reused or malformed code and maps rate limits", async () => {
    const { fetch } = fakeFetch(() => json({ message: "Not Found" }, { status: 404 }));
    await expect(convertAppManifest("abc", { fetch })).rejects.toBeInstanceOf(GitHubAppAuthError);
    await expect(convertAppManifest("../evil", { fetch })).rejects.toBeInstanceOf(GitHubAppAuthError);
    await expect(convertAppManifest("", { fetch })).rejects.toBeInstanceOf(GitHubAppAuthError);
    await expect(convertAppManifest("a".repeat(201), { fetch })).rejects.toBeInstanceOf(GitHubAppAuthError);

    const { fetch: fetch422 } = fakeFetch(() => json({ message: "Unprocessable" }, { status: 422 }));
    await expect(convertAppManifest("abc", { fetch: fetch422 })).rejects.toMatchObject({ name: "GitHubAppAuthError", status: 422 });

    const { fetch: fetch429 } = fakeFetch(() => json({ message: "rate limit" }, { status: 429 }));
    await expect(convertAppManifest("abc", { fetch: fetch429 })).rejects.toBeInstanceOf(GitHubRateLimitError);
  });
});

describe("getRepoInstallation", () => {
  it("returns the installation id and account, falling back to slug or owner", async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: 77, account: { login: "acme" } }));
    await expect(getRepoInstallation(AUTH, "acme", "widget", { fetch })).resolves.toEqual({ installationId: 77, accountLogin: "acme" });
    expect(calls[0]?.url.pathname).toBe("/repos/acme/widget/installation");
    expect(calls[0]?.headers.authorization).toMatch(/^bearer /i);

    const { fetch: slugFetch } = fakeFetch(() => json({ id: 78, account: { slug: "acme-ent" } }));
    await expect(getRepoInstallation(AUTH, "acme", "widget", { fetch: slugFetch })).resolves.toEqual({
      installationId: 78,
      accountLogin: "acme-ent",
    });

    const { fetch: nullAccountFetch } = fakeFetch(() => json({ id: 79, account: null }));
    await expect(getRepoInstallation(AUTH, "fallback-owner", "widget", { fetch: nullAccountFetch })).resolves.toEqual({
      installationId: 79,
      accountLogin: "fallback-owner",
    });
  });

  it("returns null when the App is not installed", async () => {
    const { fetch } = fakeFetch(() => json({ message: "Not Found" }, { status: 404 }));
    await expect(getRepoInstallation(AUTH, "acme", "widget", { fetch })).resolves.toBeNull();
  });

  it("maps rate limits", async () => {
    const { fetch } = fakeFetch(() =>
      json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" } }),
    );
    const error = await getRepoInstallation(AUTH, "acme", "widget", { fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt?.getTime()).toBe(2_000_000_000_000);
  });
});

describe("createInstallationToken", () => {
  it("narrows the token to the repository and permissions", async () => {
    const { fetch, calls } = fakeFetch(() => json({ token: "ghs_secret", expires_at: "2026-11-03T12:00:00Z" }, { status: 201 }));
    const result = await createInstallationToken(
      AUTH,
      77,
      { repositoryIds: [123], permissions: { contents: "write", pull_requests: "write" } },
      { fetch },
    );
    expect(result).toEqual({ token: "ghs_secret", expiresAt: new Date("2026-11-03T12:00:00Z") });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/app/installations/77/access_tokens");
    expect(calls[0]?.body).toEqual({ repository_ids: [123], permissions: { contents: "write", pull_requests: "write" } });
  });

  it("maps a missing installation, ungranted permissions, suspended 403 and rate-limited 403", async () => {
    for (const status of [404, 422, 403]) {
      const { fetch } = fakeFetch(() => json({ message: "nope" }, { status }));
      const error = await createInstallationToken(AUTH, 77, { repositoryIds: [1], permissions: { contents: "read" } }, { fetch }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(GitHubAppInstallationError);
      expect((error as GitHubAppInstallationError).status).toBe(status);
    }

    const { fetch: rateFetch } = fakeFetch(() =>
      json({ message: "rate limit" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    );
    await expect(
      createInstallationToken(AUTH, 77, { repositoryIds: [1], permissions: { contents: "read" } }, { fetch: rateFetch }),
    ).rejects.toBeInstanceOf(GitHubRateLimitError);
  });
});

describe("getCollaboratorPermission / permissionAtLeast", () => {
  it("prefers role_name, falls back to permission for custom roles or 'none', null on 404", async () => {
    const responses: Record<string, Response | (() => Response)> = {
      maintainer: () => json({ permission: "write", role_name: "maintain" }),
      custom: () => json({ permission: "write", role_name: "security-reviewer" }),
      unknown: () => json({ permission: "weird", role_name: "weird" }),
      ghost: () => json({ message: "Not Found" }, { status: 404 }),
    };
    const { fetch, calls } = fakeFetch((call) => {
      const user = call.url.pathname.split("/")[5] ?? "";
      const response = responses[user];
      return typeof response === "function" ? response() : json({}, { status: 500 });
    });
    const octokit = createOctokit({ accessToken: "ghs_x", fetch });
    await expect(getCollaboratorPermission(octokit, "acme", "widget", "maintainer")).resolves.toBe("maintain");
    await expect(getCollaboratorPermission(octokit, "acme", "widget", "custom")).resolves.toBe("write");
    await expect(getCollaboratorPermission(octokit, "acme", "widget", "unknown")).resolves.toBe("none");
    await expect(getCollaboratorPermission(octokit, "acme", "widget", "ghost")).resolves.toBeNull();
    expect(calls[0]?.url.pathname).toBe("/repos/acme/widget/collaborators/maintainer/permission");
  });

  it("orders permissions", () => {
    expect(["admin", "maintain", "write"].every((p) => permissionAtLeast(p as "write", "write"))).toBe(true);
    expect(permissionAtLeast("triage", "write")).toBe(false);
    expect(permissionAtLeast("read", "write")).toBe(false);
    expect(permissionAtLeast("triage", "read")).toBe(true);
    expect(permissionAtLeast("read", "read")).toBe(true);
    expect(permissionAtLeast("none", "read")).toBe(false);
    expect(permissionAtLeast(null, "read")).toBe(false);
  });
});

describe("getUserLoginById", () => {
  it("returns the current login, or null when the account is gone or id is invalid", async () => {
    const { fetch, calls } = fakeFetch((call) => (call.url.pathname === "/user/42" ? json({ login: "renamed" }) : json({}, { status: 404 })));
    const octokit = createOctokit({ fetch });
    await expect(getUserLoginById(octokit, "42")).resolves.toBe("renamed");
    await expect(getUserLoginById(octokit, 43)).resolves.toBeNull();
    await expect(getUserLoginById(octokit, "../x")).resolves.toBeNull();
    await expect(getUserLoginById(octokit, "")).resolves.toBeNull();
    await expect(getUserLoginById(octokit, -5)).resolves.toBeNull();
    await expect(getUserLoginById(octokit, "1".repeat(21))).resolves.toBeNull();
    expect(calls).toHaveLength(2);
  });
});

describe("installUrl", () => {
  it("pre-selects the repository only together with a valid owner account and encodes slug", () => {
    expect(installUrl("repopulse x")).toBe("https://github.com/apps/repopulse%20x/installations/new");
    expect(installUrl("repopulse-x", 123)).toBe("https://github.com/apps/repopulse-x/installations/new");
    expect(installUrl("repopulse-x", 123, 0)).toBe("https://github.com/apps/repopulse-x/installations/new");
    expect(installUrl("repopulse-x", 123, -1)).toBe("https://github.com/apps/repopulse-x/installations/new");
    expect(installUrl("repopulse-x", 123, 1.5)).toBe("https://github.com/apps/repopulse-x/installations/new");
    expect(installUrl("repopulse-x", 123, 9)).toBe(
      "https://github.com/apps/repopulse-x/installations/new/permissions?suggested_target_id=9&repository_ids%5B%5D=123",
    );
    expect(installUrl("repopulse-x", 0, 9)).toBe(
      "https://github.com/apps/repopulse-x/installations/new/permissions?suggested_target_id=9",
    );
    expect(installUrl("repopulse-x", -10, 9)).toBe(
      "https://github.com/apps/repopulse-x/installations/new/permissions?suggested_target_id=9",
    );
    expect(installUrl("repopulse-x", undefined, 9)).toBe(
      "https://github.com/apps/repopulse-x/installations/new/permissions?suggested_target_id=9",
    );
  });
});

describe("buildAppManifest / appManifestFormUrl", () => {
  it("builds the manifest of §3.8.1 and rejects non-http(s) URLs", () => {
    expect(buildAppManifest({ appBaseUrl: "https://pulse.example.com/" })).toEqual({
      name: "RepoPulse (pulse.example.com)",
      url: "https://pulse.example.com",
      redirect_url: "https://pulse.example.com/api/github-app/manifest/callback",
      setup_url: "https://pulse.example.com/dependencies?installed=1",
      setup_on_update: true,
      public: true,
      hook_attributes: { url: "https://pulse.example.com/api/github-app/webhook", active: false },
      default_permissions: { metadata: "read", contents: "write", pull_requests: "write" },
      default_events: [],
    });
    expect(() => buildAppManifest({ appBaseUrl: "ftp://pulse.example.com" })).toThrow(/http\(s\)/);
  });

  it("keeps App names within 34 characters including multi-byte code points", () => {
    const name = defaultAppName("https://releases.internal.very-long-company-name.example.com");
    expect(name.length).toBeLessThanOrEqual(34);
    expect(name).toMatch(/^RepoPulse \(releases\..*\)$/);
    expect(buildAppManifest({ appBaseUrl: "https://a.io", name: "x".repeat(50) }).name).toBe("x".repeat(34));
    expect(buildAppManifest({ appBaseUrl: "https://a.io", name: "🚀".repeat(40) }).name).toBe("🚀".repeat(34));
    expect(buildAppManifest({ appBaseUrl: "https://a.io", name: "  " }).name).toBe("RepoPulse (a.io)");
  });

  it("targets the personal account or a validated organization", () => {
    expect(appManifestFormUrl("s t")).toBe("https://github.com/settings/apps/new?state=s%20t");
    expect(appManifestFormUrl("abc", "acme-inc")).toBe("https://github.com/organizations/acme-inc/settings/apps/new?state=abc");
    expect(appManifestFormUrl("abc", " ")).toBe("https://github.com/settings/apps/new?state=abc");
    for (const bad of ["-acme", "acme-", "a--b", "evil/../x", "a".repeat(40), "acme?x=1"]) {
      expect(() => appManifestFormUrl("abc", bad)).toThrow();
    }
  });
});
