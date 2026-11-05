import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = {
  instanceSettings: { findUnique: vi.fn() },
};

const loadSmtpSettings = vi.fn();

vi.mock("@repopulse/db", () => ({
  prisma,
  INSTANCE_SETTINGS_ID: 1,
  SMTP_SETTINGS_SELECT: {},
  loadSmtpSettings,
}));

const {
  fromSmtpSecurity,
  getSmtpSettingsView,
  isSmtpConfigured,
  toSmtpSecurity,
} = await import("./smtp-settings");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("toSmtpSecurity and fromSmtpSecurity", () => {
  it("converts between nullable boolean and SmtpSecurity", () => {
    expect(toSmtpSecurity(null)).toBe("auto");
    expect(toSmtpSecurity(true)).toBe("tls");
    expect(toSmtpSecurity(false)).toBe("starttls");

    expect(fromSmtpSecurity("auto")).toBeNull();
    expect(fromSmtpSecurity("tls")).toBe(true);
    expect(fromSmtpSecurity("starttls")).toBe(false);
  });
});

describe("isSmtpConfigured", () => {
  it("returns true only when a non-blank smtpHost is stored", async () => {
    prisma.instanceSettings.findUnique.mockResolvedValueOnce(null);
    await expect(isSmtpConfigured()).resolves.toBe(false);

    prisma.instanceSettings.findUnique.mockResolvedValueOnce({ smtpHost: "   " });
    await expect(isSmtpConfigured()).resolves.toBe(false);

    prisma.instanceSettings.findUnique.mockResolvedValueOnce({ smtpHost: "smtp.example.com" });
    await expect(isSmtpConfigured()).resolves.toBe(true);
  });
});

describe("getSmtpSettingsView", () => {
  it("builds the view model and never leaks the encrypted password", async () => {
    prisma.instanceSettings.findUnique.mockResolvedValueOnce(null);
    await expect(getSmtpSettingsView()).resolves.toEqual({
      host: "",
      port: 587,
      security: "auto",
      user: "",
      hasPassword: false,
      from: "",
      defaultFrom: null,
      enabled: false,
    });

    prisma.instanceSettings.findUnique.mockResolvedValueOnce({
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecure: true,
      smtpUser: "alerts@example.com",
      smtpPasswordEncrypted: "enc(super-secret-password)",
      smtpFrom: null,
    });
    const view = await getSmtpSettingsView();
    expect(view).toEqual({
      host: "smtp.example.com",
      port: 465,
      security: "tls",
      user: "alerts@example.com",
      hasPassword: true,
      from: "",
      defaultFrom: "RepoPulse <alerts@example.com>",
      enabled: true,
    });
    expect(JSON.stringify(view)).not.toContain("super-secret-password");
  });
});
