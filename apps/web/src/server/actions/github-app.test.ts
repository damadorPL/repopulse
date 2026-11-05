import { beforeEach, describe, expect, it, vi } from "vitest";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}
class GitHubAppAuthError extends Error {}
class GitHubRateLimitError extends Error {}
class GitHubAppKeyUnreadableError extends Error {}

const currentUser = { id: "u1", isSuperAdmin: true, githubLogin: "admin" };
const prisma = {
  instanceSettings: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
};
const cookieStore = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
const getAuthenticatedApp = vi.fn();
const updateAppWebhookConfig = vi.fn();
const loadGitHubAppSettings = vi.fn();
const env = { appBaseUrl: "https://pulse.example.com" };

vi.mock("@/lib/auth", () => ({
  UnauthorizedError,
  ForbiddenError,
  getCurrentUserOrThrow: vi.fn(async () => currentUser),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => cookieStore) }));
vi.mock("@repopulse/db", () => ({
  prisma,
  INSTANCE_SETTINGS_ID: 1,
  GitHubAppKeyUnreadableError,
  loadGitHubAppSettings,
  GITHUB_APP_SETTINGS_SELECT: {},
  encryptToken: (value: string) => `enc(${value})`,
  decryptToken: (value: string) => value.replace(/^enc\(([\s\S]*)\)$/, "$1"),
}));
vi.mock("@repopulse/github", () => ({
  GitHubAppAuthError,
  GitHubRateLimitError,
  GitHubRepositoryNotFoundError: class extends Error {},
  InvalidRepositoryInputError: class extends Error {},
  getAuthenticatedApp,
  updateAppWebhookConfig,
  buildAppManifest: ({ appBaseUrl, name }: { appBaseUrl: string; name?: string }) => ({ name: name ?? "RepoPulse (test)", url: appBaseUrl }),
  appManifestFormUrl: (state: string, org?: string) =>
    org ? `https://github.com/organizations/${org}/settings/apps/new?state=${state}` : `https://github.com/settings/apps/new?state=${state}`,
}));
vi.mock("@repopulse/notifications", () => ({ resolveAppBaseUrl: () => env.appBaseUrl }));

const { enableGitHubAppWebhooksAction, removeGitHubAppSettingsAction, saveGitHubAppSettingsAction, startGitHubAppManifestAction } = await import(
  "./github-app"
);

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretsecret\n-----END RSA PRIVATE KEY-----";
const SAVED_ROW = {
  githubAppId: 42,
  githubAppSlug: "repopulse-test",
  githubAppClientId: "Iv1.abc",
  githubAppOwner: "admin",
  githubAppPrivateKeyEncrypted: `enc(${PEM})`,
  githubAppWebhookSecretEncrypted: "enc(hook-secret)",
};

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.isSuperAdmin = true;
  env.appBaseUrl = "https://pulse.example.com";
  updateAppWebhookConfig.mockResolvedValue({ url: "https://pulse.example.com/api/github-app/webhook", contentType: "json", hasSecret: true, insecureSsl: false });
  loadGitHubAppSettings.mockResolvedValue({ appId: 42, slug: "repopulse-test", clientId: "Iv1.abc", owner: "admin", privateKey: PEM, webhookSecret: null });
  prisma.instanceSettings.findUnique.mockResolvedValue(SAVED_ROW);
  getAuthenticatedApp.mockResolvedValue({
    id: 42,
    slug: "repopulse-test",
    name: "RepoPulse (test)",
    clientId: "Iv1.abc",
    owner: "admin",
    htmlUrl: "https://github.com/apps/repopulse-test",
  });
});

describe("super admin only", () => {
  it("returns FORBIDDEN to members and writes nothing", async () => {
    currentUser.isSuperAdmin = false;
    const results = await Promise.all([
      startGitHubAppManifestAction({ organization: "" }),
      saveGitHubAppSettingsAction({ appId: 42, slug: "repopulse-test", privateKey: PEM }),
      removeGitHubAppSettingsAction(),
      enableGitHubAppWebhooksAction(),
    ]);
    for (const result of results) expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(cookieStore.set).not.toHaveBeenCalled();
    expect(prisma.instanceSettings.upsert).not.toHaveBeenCalled();
    expect(getAuthenticatedApp).not.toHaveBeenCalled();
    expect(updateAppWebhookConfig).not.toHaveBeenCalled();
    expect(prisma.instanceSettings.update).not.toHaveBeenCalled();
  });
});

describe("startGitHubAppManifestAction", () => {
  it("sets a 10-minute httpOnly state cookie and returns the GitHub form URL with the same state", async () => {
    const result = await startGitHubAppManifestAction({ organization: "my-org", name: "RepoPulse prod" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(cookieStore.set).toHaveBeenCalledTimes(1);
    const [name, state, options] = cookieStore.set.mock.calls[0]!;
    expect(name).toBe("repopulse_github_app_state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", maxAge: 600, path: "/api/github-app/manifest" });
    expect(result.data.formUrl).toBe(`https://github.com/organizations/my-org/settings/apps/new?state=${state}`);
    expect(JSON.parse(result.data.manifest)).toEqual({ name: "RepoPulse prod", url: "https://pulse.example.com" });
  });

  it("uses a new state each time", async () => {
    await startGitHubAppManifestAction({});
    await startGitHubAppManifestAction({});
    expect(cookieStore.set.mock.calls[0]![1]).not.toBe(cookieStore.set.mock.calls[1]![1]);
  });

  it("rejects an invalid organization and unknown fields", async () => {
    expect(await startGitHubAppManifestAction({ organization: "not a login" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await startGitHubAppManifestAction({ organization: "", extra: 1 } as never)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("returns UNAVAILABLE when buildAppManifest throws on an invalid APP_BASE_URL", async () => {
    env.appBaseUrl = "not-a-valid-url";
    const github = await import("@repopulse/github");
    vi.spyOn(github, "buildAppManifest").mockImplementationOnce(() => {
      throw new Error("Invalid URL");
    });

    const result = await startGitHubAppManifestAction({ organization: "" });
    expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});

describe("saveGitHubAppSettingsAction", () => {
  it("validates the key with GitHub and stores it encrypted; the result never contains a secret", async () => {
    const result = await saveGitHubAppSettingsAction({ appId: 42, slug: "Repopulse-Test", privateKey: PEM, webhookSecret: "new-secret" });
    expect(result.ok).toBe(true);
    expect(getAuthenticatedApp).toHaveBeenCalledWith({ appId: 42, privateKey: PEM });
    const data = prisma.instanceSettings.upsert.mock.calls[0]![0].update;
    expect(data).toMatchObject({
      githubAppId: 42,
      githubAppSlug: "repopulse-test",
      githubAppClientId: "Iv1.abc",
      githubAppOwner: "admin",
      githubAppPrivateKeyEncrypted: `enc(${PEM})`,
      githubAppWebhookSecretEncrypted: "enc(new-secret)",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain("hook-secret");
    expect(serialized).not.toContain("new-secret");
    if (result.ok) expect(result.data).toMatchObject({ configured: true, keySaved: true, keyReadable: true, webhookSecretSaved: true });
  });

  it("keeps the saved webhook secret for the same App and drops it for another App", async () => {
    await saveGitHubAppSettingsAction({ appId: 42, slug: "repopulse-test", privateKey: PEM });
    expect(prisma.instanceSettings.upsert.mock.calls[0]![0].update).not.toHaveProperty("githubAppWebhookSecretEncrypted");

    prisma.instanceSettings.findUnique.mockResolvedValueOnce({ githubAppId: 7 });
    await saveGitHubAppSettingsAction({ appId: 42, slug: "repopulse-test", privateKey: PEM });
    expect(prisma.instanceSettings.upsert.mock.calls[1]![0].update).toMatchObject({ githubAppWebhookSecretEncrypted: null });
  });

  it("rejects a slug or App ID that doesn't match the App GitHub returns", async () => {
    const result = await saveGitHubAppSettingsAction({ appId: 42, slug: "other-app", privateKey: PEM });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(prisma.instanceSettings.upsert).not.toHaveBeenCalled();

    getAuthenticatedApp.mockResolvedValueOnce({
      id: 99,
      slug: "repopulse-test",
      name: "RepoPulse (test)",
      clientId: "Iv1.abc",
      owner: "admin",
      htmlUrl: "https://github.com/apps/repopulse-test",
    });
    const mismatchedId = await saveGitHubAppSettingsAction({ appId: 42, slug: "repopulse-test", privateKey: PEM });
    expect(mismatchedId).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(prisma.instanceSettings.upsert).not.toHaveBeenCalled();
  });

  it("maps a rejected key to INVALID_INPUT without echoing it", async () => {
    getAuthenticatedApp.mockRejectedValueOnce(new GitHubAppAuthError("No GitHub App matches this App id and private key."));
    const result = await saveGitHubAppSettingsAction({ appId: 42, slug: "repopulse-test", privateKey: PEM });
    expect(result).toEqual({ ok: false, error: { code: "INVALID_INPUT", message: "No GitHub App matches this App id and private key." } });
    expect(prisma.instanceSettings.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing id", { appId: Number.NaN, slug: "repopulse-test", privateKey: PEM }],
    ["a bad slug", { appId: 42, slug: "Not A Slug!", privateKey: PEM }],
    ["something that isn't a PEM", { appId: 42, slug: "repopulse-test", privateKey: "hunter2" }],
    ["unknown fields", { appId: 42, slug: "repopulse-test", privateKey: PEM, owner: "x" }],
  ])("rejects %s before calling GitHub", async (_label, input) => {
    const result = await saveGitHubAppSettingsAction(input as never);
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(getAuthenticatedApp).not.toHaveBeenCalled();
  });
});

describe("removeGitHubAppSettingsAction", () => {
  it("clears every App column", async () => {
    prisma.instanceSettings.findUnique.mockResolvedValue(null);
    const result = await removeGitHubAppSettingsAction();
    expect(prisma.instanceSettings.upsert.mock.calls[0]![0].update).toEqual({
      githubAppId: null,
      githubAppSlug: null,
      githubAppClientId: null,
      githubAppOwner: null,
      githubAppPrivateKeyEncrypted: null,
      githubAppWebhookSecretEncrypted: null,
    });
    expect(result).toMatchObject({ ok: true, data: { configured: false, keySaved: false, webhookSecretSaved: false } });
  });
});

describe("enableGitHubAppWebhooksAction", () => {
  const WEBHOOK_URL = "https://pulse.example.com/api/github-app/webhook";

  it("generates a secret when none is saved, sends it to GitHub, then stores it encrypted", async () => {
    const result = await enableGitHubAppWebhooksAction({});
    expect(result).toEqual({ ok: true, data: { webhookUrl: WEBHOOK_URL, secretCreated: true } });
    expect(updateAppWebhookConfig).toHaveBeenCalledTimes(1);
    const [auth, config] = updateAppWebhookConfig.mock.calls[0]!;
    expect(auth).toEqual({ appId: 42, privateKey: PEM });
    expect(config).toMatchObject({ url: WEBHOOK_URL, contentType: "json" });
    expect(config.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(prisma.instanceSettings.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { githubAppWebhookSecretEncrypted: `enc(${config.secret})` },
    });
    expect(JSON.stringify(result)).not.toContain(config.secret);
  });

  it("reuses the saved secret unless asked to rotate it", async () => {
    loadGitHubAppSettings.mockResolvedValue({ appId: 42, slug: "repopulse-test", clientId: null, owner: null, privateKey: PEM, webhookSecret: "saved-secret-0123456789" });
    expect(await enableGitHubAppWebhooksAction()).toMatchObject({ ok: true, data: { secretCreated: false } });
    expect(updateAppWebhookConfig.mock.calls[0]![1].secret).toBe("saved-secret-0123456789");
    expect(prisma.instanceSettings.update).not.toHaveBeenCalled();

    expect(await enableGitHubAppWebhooksAction({ rotateSecret: true })).toMatchObject({ ok: true, data: { secretCreated: true } });
    const rotated = updateAppWebhookConfig.mock.calls[1]![1].secret as string;
    expect(rotated).not.toBe("saved-secret-0123456789");
    expect(prisma.instanceSettings.update).toHaveBeenCalledWith(expect.objectContaining({ data: { githubAppWebhookSecretEncrypted: `enc(${rotated})` } }));
  });

  it.each(["http://pulse.example.com", "https://localhost:3000", "https://192.168.1.20", "https://repopulse", "https://pulse.internal"])(
    "is unavailable for APP_BASE_URL %s",
    async (appBaseUrl) => {
      env.appBaseUrl = appBaseUrl;
      expect(await enableGitHubAppWebhooksAction()).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(loadGitHubAppSettings).not.toHaveBeenCalled();
      expect(updateAppWebhookConfig).not.toHaveBeenCalled();
    },
  );

  it("needs a configured, readable App", async () => {
    loadGitHubAppSettings.mockResolvedValueOnce(null);
    expect(await enableGitHubAppWebhooksAction()).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    loadGitHubAppSettings.mockRejectedValueOnce(new GitHubAppKeyUnreadableError("can't be decrypted"));
    expect(await enableGitHubAppWebhooksAction()).toMatchObject({ ok: false, error: { code: "UNAVAILABLE", message: "can't be decrypted" } });
    expect(updateAppWebhookConfig).not.toHaveBeenCalled();
  });

  it("stores nothing when GitHub rejects the change", async () => {
    updateAppWebhookConfig.mockRejectedValueOnce(new GitHubAppAuthError("GitHub rejected the App credentials."));
    expect(await enableGitHubAppWebhooksAction()).toEqual({ ok: false, error: { code: "UNAVAILABLE", message: "GitHub rejected the App credentials." } });
    expect(prisma.instanceSettings.update).not.toHaveBeenCalled();
  });

  it("rejects unknown fields", async () => {
    expect(await enableGitHubAppWebhooksAction({ secret: "mine" } as never)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(updateAppWebhookConfig).not.toHaveBeenCalled();
  });
});
