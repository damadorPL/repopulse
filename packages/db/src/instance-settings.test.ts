import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken } from "./crypto";
import { loadBackfillOverrides, loadSmtpSettings, NO_BACKFILL_OVERRIDES, SmtpPasswordUnreadableError } from "./instance-settings";

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

  it("returns a null password when none is stored", async () => {
    await expect(loadSmtpSettings(client({ ...row, smtpPasswordEncrypted: null }))).resolves.toMatchObject({ smtpPassword: null });
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
