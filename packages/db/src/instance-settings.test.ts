import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken } from "./crypto.js";
import {
  createCachedLoader,
  GitHubAppKeyUnreadableError,
  loadAdminSettingsSnapshot,
  loadBackfillOverrides,
  loadDepsEnabled,
  loadGitHubAppSettings,
  loadGitHubAppWebhookSettings,
  loadSmtpSettings,
  NO_BACKFILL_OVERRIDES,
  SmtpPasswordUnreadableError,
} from "./instance-settings.js";

const row = {
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpSecure: null,
  smtpUser: "bot@example.com",
  smtpFrom: null,
};

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
    await expect(loadSmtpSettings(client({ ...row, smtpPasswordEncrypted: null }))).resolves.toMatchObject({
      smtpPassword: null,
    });
    await expect(loadSmtpSettings(client({ ...row, smtpPasswordEncrypted: "" }))).resolves.toMatchObject({
      smtpPassword: null,
    });
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
    expect(overrides).toEqual({
      defaultTarget: 300,
      maxAgeDays: 0,
      hardCap: null,
      minQuota: null,
      deepStep: 50,
      deepCooldownMinutes: 1,
    });
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
      loadGitHubAppSettings(
        client({
          ...baseAppRow,
          githubAppId: null,
          githubAppPrivateKeyEncrypted: encKey,
          githubAppWebhookSecretEncrypted: null,
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      loadGitHubAppSettings(
        client({
          ...baseAppRow,
          githubAppSlug: null,
          githubAppPrivateKeyEncrypted: encKey,
          githubAppWebhookSecretEncrypted: null,
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      loadGitHubAppSettings(
        client({
          ...baseAppRow,
          githubAppSlug: "",
          githubAppPrivateKeyEncrypted: encKey,
          githubAppWebhookSecretEncrypted: null,
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      loadGitHubAppSettings(
        client({ ...baseAppRow, githubAppPrivateKeyEncrypted: null, githubAppWebhookSecretEncrypted: null }),
      ),
    ).resolves.toBeNull();
    await expect(
      loadGitHubAppSettings(
        client({ ...baseAppRow, githubAppPrivateKeyEncrypted: "", githubAppWebhookSecretEncrypted: null }),
      ),
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

describe("loadGitHubAppWebhookSettings", () => {
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  });
  afterEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it("returns depsEnabled=false and app=null when row is null", async () => {
    await expect(loadGitHubAppWebhookSettings(client(null))).resolves.toEqual({ depsEnabled: false, app: null });
  });

  it("returns depsEnabled and app=null without decrypting webhook secret when app is unconfigured", async () => {
    await expect(
      loadGitHubAppWebhookSettings(
        client({
          depsEnabled: true,
          githubAppId: null,
          githubAppSlug: "app",
          githubAppPrivateKeyEncrypted: null,
          githubAppWebhookSecretEncrypted: "invalid-ciphertext",
        }),
      ),
    ).resolves.toEqual({ depsEnabled: true, app: null });
  });

  it("decrypts webhook secret in a single query when app is configured", async () => {
    const db = client({
      depsEnabled: true,
      githubAppId: 123,
      githubAppSlug: "repopulse-app",
      githubAppPrivateKeyEncrypted: "not-decrypted-here",
      githubAppWebhookSecretEncrypted: encryptToken("whsec_live"),
    });
    await expect(loadGitHubAppWebhookSettings(db)).resolves.toEqual({
      depsEnabled: true,
      app: { webhookSecret: "whsec_live" },
    });
  });

  it("throws GitHubAppKeyUnreadableError when webhook secret decryption fails", async () => {
    const encrypted = encryptToken("whsec_live");
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await expect(
      loadGitHubAppWebhookSettings(
        client({
          depsEnabled: true,
          githubAppId: 123,
          githubAppSlug: "repopulse-app",
          githubAppPrivateKeyEncrypted: "opaque",
          githubAppWebhookSecretEncrypted: encrypted,
        }),
      ),
    ).rejects.toBeInstanceOf(GitHubAppKeyUnreadableError);
  });
});

describe("loadAdminSettingsSnapshot", () => {
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  });
  afterEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it("returns safe defaults when settings row does not exist", async () => {
    await expect(loadAdminSettingsSnapshot(client(null))).resolves.toEqual({
      publicRegistration: true,
      depsEnabled: false,
      smtp: {
        host: null,
        port: 587,
        secure: null,
        user: null,
        hasPassword: false,
        from: null,
      },
      backfillOverrides: NO_BACKFILL_OVERRIDES,
      githubApp: {
        configured: false,
        appId: null,
        slug: null,
        clientId: null,
        owner: null,
        keySaved: false,
        keyReadable: false,
        webhookSecretSaved: false,
      },
    });
  });

  it("maps all sections in one query without exposing ciphertext", async () => {
    const snap = await loadAdminSettingsSnapshot(
      client({
        publicRegistration: false,
        depsEnabled: true,
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUser: "mailer",
        smtpPasswordEncrypted: encryptToken("pass"),
        smtpFrom: "noreply@example.com",
        backfillDefaultTarget: 200,
        backfillMaxAgeDays: 30,
        backfillHardCap: 500,
        backfillMinQuota: 50,
        backfillDeepStep: 25,
        backfillDeepCooldownMinutes: 5,
        githubAppId: 99,
        githubAppSlug: "rp-app",
        githubAppClientId: "Iv1",
        githubAppOwner: "org",
        githubAppPrivateKeyEncrypted: encryptToken("pem"),
        githubAppWebhookSecretEncrypted: encryptToken("whsec"),
      }),
    );

    expect(snap).toEqual({
      publicRegistration: false,
      depsEnabled: true,
      smtp: {
        host: "smtp.example.com",
        port: 465,
        secure: true,
        user: "mailer",
        hasPassword: true,
        from: "noreply@example.com",
      },
      backfillOverrides: {
        defaultTarget: 200,
        maxAgeDays: 30,
        hardCap: 500,
        minQuota: 50,
        deepStep: 25,
        deepCooldownMinutes: 5,
      },
      githubApp: {
        configured: true,
        appId: 99,
        slug: "rp-app",
        clientId: "Iv1",
        owner: "org",
        keySaved: true,
        keyReadable: true,
        webhookSecretSaved: true,
      },
    });
  });

  it("reports keyReadable=false when the stored GitHub App key cannot be decrypted", async () => {
    const encrypted = encryptToken("pem");
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    const snap = await loadAdminSettingsSnapshot(
      client({
        publicRegistration: true,
        depsEnabled: false,
        smtpHost: null,
        smtpPort: 587,
        smtpSecure: null,
        smtpUser: null,
        smtpPasswordEncrypted: null,
        smtpFrom: null,
        backfillDefaultTarget: null,
        backfillMaxAgeDays: null,
        backfillHardCap: null,
        backfillMinQuota: null,
        backfillDeepStep: null,
        backfillDeepCooldownMinutes: null,
        githubAppId: 99,
        githubAppSlug: "rp-app",
        githubAppClientId: null,
        githubAppOwner: null,
        githubAppPrivateKeyEncrypted: encrypted,
        githubAppWebhookSecretEncrypted: null,
      }),
    );
    expect(snap.githubApp.keySaved).toBe(true);
    expect(snap.githubApp.keyReadable).toBe(false);
  });
});

describe("createCachedLoader", () => {
  it("caches within TTL, expires after TTL, and supports invalidate()", async () => {
    let time = 1_000;
    let count = 0;
    const cached = createCachedLoader(async () => `v${++count}`, { ttlMs: 15_000, now: () => time });

    await expect(cached()).resolves.toBe("v1");
    time += 10_000;
    await expect(cached()).resolves.toBe("v1");
    expect(count).toBe(1);

    time += 5_000;
    await expect(cached()).resolves.toBe("v2");
    expect(count).toBe(2);

    cached.invalidate();
    await expect(cached()).resolves.toBe("v3");
    expect(count).toBe(3);
  });

  it("deduplicates concurrent calls and never caches errors", async () => {
    let count = 0;
    let resolveFirst!: (value: string) => void;
    const loader = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            count++;
            resolveFirst = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("transient"))
      .mockImplementationOnce(async () => `ok-${++count}`);

    const cached = createCachedLoader(loader, { ttlMs: 15_000 });
    const p1 = cached();
    const p2 = cached();
    resolveFirst("first");
    await expect(Promise.all([p1, p2])).resolves.toEqual(["first", "first"]);
    expect(loader).toHaveBeenCalledTimes(1);

    cached.invalidate();
    await expect(cached()).rejects.toThrow("transient");
    await expect(cached()).resolves.toBe("ok-2");
    expect(loader).toHaveBeenCalledTimes(3);
  });
});
