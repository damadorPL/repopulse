import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken } from "./crypto";
import {
  GitHubAppKeyUnreadableError,
  loadBackfillOverrides,
  loadDepsEnabled,
  loadGitHubAppSettings,
  loadSmtpSettings,
  NO_BACKFILL_OVERRIDES,
  SmtpPasswordUnreadableError,
} from "./instance-settings";

const row = { smtpHost: "smtp.example.com", smtpPort: 587, smtpSecure: null, smtpUser: "bot@example.com", smtpFrom: null };

function client(value: unknown) {
  return { instanceSettings: { findUnique: vi.fn(async () => value) } } as never;
}

describe("loadSmtpSettings", () => {
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  });
  afterEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it("returns null without a settings row", async () => {
    await expect(loadSmtpSettings(client(null))).resolves.toBeNull();
  });

  it("decrypts the stored password and never returns the ciphertext", async () => {
    const settings = await loadSmtpSettings(client({ ...row, smtpPasswordEncrypted: encryptToken("s3cret") }));
    expect(settings).toEqual({ ...row, smtpPassword: "s3cret" });
    expect(settings).not.toHaveProperty("smtpPasswordEncrypted");
  });

  it("returns a null password when none is stored or empty string", async () => {
    await expect(loadSmtpSettings(client({ ...row, smtpPasswordEncrypted: null }))).resolves.toMatchObject({ smtpPassword: null });
    await expect(loadSmtpSettings(client({ ...row, smtpPasswordEncrypted: "" }))).resolves.toMatchObject({ smtpPassword: null });
  });

  it("throws SmtpPasswordUnreadableError after a key change", async () => {
    const encrypted = encryptToken("s3cret");
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await expect(loadSmtpSettings(client({ ...row, smtpPasswordEncrypted: encrypted }))).rejects.toBeInstanceOf(
      SmtpPasswordUnreadableError,
    );
  });
});

describe("loadBackfillOverrides", () => {
  it("returns no overrides without a settings row", async () => {
    await expect(loadBackfillOverrides(client(null))).resolves.toEqual(NO_BACKFILL_OVERRIDES);
  });

  it("maps the columns to config keys", async () => {
    const overrides = await loadBackfillOverrides(
      client({
        backfillDefaultTarget: 300,
        backfillMaxAgeDays: 0,
        backfillHardCap: null,
        backfillMinQuota: null,
        backfillDeepStep: 50,
        backfillDeepCooldownMinutes: 1,
      }),
    );
    expect(overrides).toEqual({ defaultTarget: 300, maxAgeDays: 0, hardCap: null, minQuota: null, deepStep: 50, deepCooldownMinutes: 1 });
  });
});

describe("loadGitHubAppSettings", () => {
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  });
  afterEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  });

  const baseAppRow = {
    githubAppId: 4242,
    githubAppSlug: "repopulse-app",
    githubAppClientId: "Iv23abc",
    githubAppOwner: "acme",
  };

  it("returns null when row is null or required fields are missing or empty", async () => {
    const encKey = encryptToken("pem-key");
    await expect(loadGitHubAppSettings(client(null))).resolves.toBeNull();
    await expect(
      loadGitHubAppSettings(client({ ...baseAppRow, githubAppId: null, githubAppPrivateKeyEncrypted: encKey, githubAppWebhookSecretEncrypted: null })),
    ).resolves.toBeNull();
    await expect(
      loadGitHubAppSettings(client({ ...baseAppRow, githubAppSlug: null, githubAppPrivateKeyEncrypted: encKey, githubAppWebhookSecretEncrypted: null })),
    ).resolves.toBeNull();
    await expect(
      loadGitHubAppSettings(client({ ...baseAppRow, githubAppSlug: "", githubAppPrivateKeyEncrypted: encKey, githubAppWebhookSecretEncrypted: null })),
    ).resolves.toBeNull();
    await expect(
      loadGitHubAppSettings(client({ ...baseAppRow, githubAppPrivateKeyEncrypted: null, githubAppWebhookSecretEncrypted: null })),
    ).resolves.toBeNull();
    await expect(
      loadGitHubAppSettings(client({ ...baseAppRow, githubAppPrivateKeyEncrypted: "", githubAppWebhookSecretEncrypted: null })),
    ).resolves.toBeNull();
  });

  it("decrypts private key and webhook secret and never exposes encrypted columns", async () => {
    const withSecret = await loadGitHubAppSettings(
      client({
        ...baseAppRow,
        githubAppPrivateKeyEncrypted: encryptToken("-----BEGIN RSA PRIVATE KEY-----"),
        githubAppWebhookSecretEncrypted: encryptToken("whsec_123"),
      }),
    );
    expect(withSecret).toEqual({
      appId: 4242,
      slug: "repopulse-app",
      clientId: "Iv23abc",
      owner: "acme",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----",
      webhookSecret: "whsec_123",
    });
    expect(withSecret).not.toHaveProperty("githubAppPrivateKeyEncrypted");
    expect(withSecret).not.toHaveProperty("githubAppWebhookSecretEncrypted");

    const withoutSecret = await loadGitHubAppSettings(
      client({
        ...baseAppRow,
        githubAppClientId: null,
        githubAppOwner: null,
        githubAppPrivateKeyEncrypted: encryptToken("pem-key"),
        githubAppWebhookSecretEncrypted: null,
      }),
    );
    expect(withoutSecret).toEqual({
      appId: 4242,
      slug: "repopulse-app",
      clientId: null,
      owner: null,
      privateKey: "pem-key",
      webhookSecret: null,
    });
  });

  it("throws GitHubAppKeyUnreadableError with cause when privateKey or webhookSecret fails decryption", async () => {
    const validKey = encryptToken("pem-key");
    const validSecret = encryptToken("whsec_123");
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");

    const keyErr = await loadGitHubAppSettings(
      client({
        ...baseAppRow,
        githubAppPrivateKeyEncrypted: validKey,
        githubAppWebhookSecretEncrypted: null,
      }),
    ).catch((e: unknown) => e);
    expect(keyErr).toBeInstanceOf(GitHubAppKeyUnreadableError);
    expect((keyErr as GitHubAppKeyUnreadableError).cause).toBeInstanceOf(Error);

    const freshKey = encryptToken("pem-key-2");
    const secretErr = await loadGitHubAppSettings(
      client({
        ...baseAppRow,
        githubAppPrivateKeyEncrypted: freshKey,
        githubAppWebhookSecretEncrypted: validSecret,
      }),
    ).catch((e: unknown) => e);
    expect(secretErr).toBeInstanceOf(GitHubAppKeyUnreadableError);
    expect((secretErr as GitHubAppKeyUnreadableError).cause).toBeInstanceOf(Error);
  });
});

describe("loadDepsEnabled", () => {
  it("returns false when settings row is null or depsEnabled is false, and true when enabled", async () => {
    await expect(loadDepsEnabled(client(null))).resolves.toBe(false);
    await expect(loadDepsEnabled(client({ depsEnabled: false }))).resolves.toBe(false);
    await expect(loadDepsEnabled(client({ depsEnabled: true }))).resolves.toBe(true);
  });
});
