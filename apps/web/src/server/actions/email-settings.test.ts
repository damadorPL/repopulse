import { beforeEach, describe, expect, it, vi } from "vitest";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}
class SmtpPasswordUnreadableError extends Error {}

const currentUser = { id: "admin1", email: "admin@example.com", name: "Admin", isSuperAdmin: true };

const prisma = {
  instanceSettings: { upsert: vi.fn() },
};

const getSmtpConfig = vi.fn();
const getSmtpSettingsView = vi.fn();
const dispatchNotification = vi.fn();
const isNotificationDeliveryError = vi.fn(() => false);

vi.mock("@/lib/auth", () => ({
  UnauthorizedError,
  ForbiddenError,
  getCurrentUserOrThrow: vi.fn(async () => currentUser),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@repopulse/db", () => ({
  prisma,
  INSTANCE_SETTINGS_ID: 1,
  SmtpPasswordUnreadableError,
  encryptToken: (val: string) => `enc(${val})`,
}));
vi.mock("@repopulse/github", () => ({
  GitHubRateLimitError: class extends Error {},
  GitHubRepositoryNotFoundError: class extends Error {},
  InvalidRepositoryInputError: class extends Error {},
}));
vi.mock("@repopulse/notifications", () => ({
  buildTestRelease: () => ({ release: {}, repository: {} }),
  dispatchNotification,
  isNotificationDeliveryError,
  resolveAppBaseUrl: () => "https://pulse.example.com",
}));
vi.mock("@/server/smtp-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/smtp-settings")>()),
  getSmtpConfig,
  getSmtpSettingsView,
}));

const { getCurrentUserOrThrow } = await import("@/lib/auth");
const { removeSmtpSettingsAction, saveSmtpSettingsAction, sendSmtpTestEmailAction } = await import("./email-settings");

const baseInput = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls" as const,
  user: "mailer",
  password: "",
  clearPassword: false,
  from: "RepoPulse <noreply@example.com>",
};

const viewStub = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls" as const,
  user: "mailer",
  hasPassword: true,
  from: "RepoPulse <noreply@example.com>",
  defaultFrom: "RepoPulse <mailer@smtp.example.com>",
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.isSuperAdmin = true;
  vi.mocked(getCurrentUserOrThrow).mockResolvedValue(currentUser as never);
  getSmtpSettingsView.mockResolvedValue(viewStub);
  getSmtpConfig.mockResolvedValue({ host: "smtp.example.com", port: 587, secure: false });
  dispatchNotification.mockResolvedValue({ destination: "admin@example.com" });
  isNotificationDeliveryError.mockReturnValue(false);
});

describe("super admin guard across email-settings actions", () => {
  it("returns FORBIDDEN for regular users and UNAUTHORIZED when signed out", async () => {
    currentUser.isSuperAdmin = false;
    expect(await saveSmtpSettingsAction(baseInput)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await removeSmtpSettingsAction()).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await sendSmtpTestEmailAction({})).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    vi.mocked(getCurrentUserOrThrow).mockRejectedValue(new UnauthorizedError("Not signed in"));
    expect(await saveSmtpSettingsAction(baseInput)).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(await removeSmtpSettingsAction()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(await sendSmtpTestEmailAction({})).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
  });
});

describe("saveSmtpSettingsAction", () => {
  it("keeps existing password when password is empty and clearPassword is false", async () => {
    await saveSmtpSettingsAction(baseInput);
    const update = prisma.instanceSettings.upsert.mock.calls[0]![0].update;
    expect(update).not.toHaveProperty("smtpPasswordEncrypted");
  });

  it("encrypts password when non-empty", async () => {
    await saveSmtpSettingsAction({ ...baseInput, password: "secret-password" });
    const update = prisma.instanceSettings.upsert.mock.calls[0]![0].update;
    expect(update).toMatchObject({ smtpPasswordEncrypted: "enc(secret-password)" });
  });

  it("clears password when user is empty or clearPassword is true", async () => {
    await saveSmtpSettingsAction({ ...baseInput, user: "", password: "ignored" });
    expect(prisma.instanceSettings.upsert.mock.calls[0]![0].update).toMatchObject({
      smtpUser: null,
      smtpPasswordEncrypted: null,
    });

    await saveSmtpSettingsAction({ ...baseInput, clearPassword: true, password: "ignored" });
    expect(prisma.instanceSettings.upsert.mock.calls[1]![0].update).toMatchObject({
      smtpPasswordEncrypted: null,
    });
  });
});

describe("removeSmtpSettingsAction", () => {
  it("resets all SMTP columns in instanceSettings", async () => {
    const result = await removeSmtpSettingsAction();
    expect(result).toEqual({ ok: true, data: viewStub });
    expect(prisma.instanceSettings.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      create: {
        id: 1,
        smtpHost: null,
        smtpPort: 587,
        smtpSecure: null,
        smtpUser: null,
        smtpPasswordEncrypted: null,
        smtpFrom: null,
      },
      update: {
        smtpHost: null,
        smtpPort: 587,
        smtpSecure: null,
        smtpUser: null,
        smtpPasswordEncrypted: null,
        smtpFrom: null,
      },
    });
  });
});

describe("sendSmtpTestEmailAction", () => {
  let now = 1_700_000_000_000;

  beforeEach(() => {
    now += 20_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  it("enforces the 10-second cooldown and maps delivery errors to DELIVERY_FAILED", async () => {
    getSmtpConfig.mockRejectedValueOnce(new SmtpPasswordUnreadableError("Cannot decrypt SMTP password"));
    expect(await sendSmtpTestEmailAction({})).toEqual({
      ok: false,
      error: { code: "DELIVERY_FAILED", message: "Cannot decrypt SMTP password" },
    });

    const okResult = await sendSmtpTestEmailAction({ to: "test@example.com" });
    expect(okResult).toEqual({ ok: true, data: { to: "admin@example.com" } });

    // Cooldown hit within 10s
    now += 3_000;
    const rateLimited = await sendSmtpTestEmailAction({});
    expect(rateLimited).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });

    // Advance past cooldown and test NotificationDeliveryError mapping
    now += 10_000;
    isNotificationDeliveryError.mockReturnValueOnce(true);
    dispatchNotification.mockRejectedValueOnce(new Error("SMTP connection refused"));
    expect(await sendSmtpTestEmailAction({})).toEqual({
      ok: false,
      error: { code: "DELIVERY_FAILED", message: "SMTP connection refused" },
    });
  });
});
