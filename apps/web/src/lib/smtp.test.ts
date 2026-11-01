import { describe, expect, it } from "vitest";
import { isValidSender, isValidSmtpHost, smtpSettingsInput } from "./smtp";

const valid = {
  host: "smtp.example.com",
  port: 587,
  security: "auto",
  user: "",
  password: "",
  clearPassword: false,
  from: "",
} as const;

describe("SMTP settings validation", () => {
  it("accepts host names and IP addresses, not URLs or host:port", () => {
    for (const host of ["smtp.example.com", "mail", "relay.internal.lan", "10.0.0.5", "::1", "[2001:db8::1]"]) {
      expect(isValidSmtpHost(host), host).toBe(true);
    }
    for (const host of ["smtp://smtp.example.com", "smtp.example.com:587", "smtp example.com", "-bad.example.com", ""]) {
      expect(isValidSmtpHost(host), host).toBe(false);
    }
  });

  it("accepts a sender address with or without a display name", () => {
    expect(isValidSender("releases@example.com")).toBe(true);
    expect(isValidSender("RepoPulse <releases@example.com>")).toBe(true);
    expect(isValidSender("RepoPulse")).toBe(false);
    expect(isValidSender("RepoPulse <not-an-address>")).toBe(false);
    expect(isValidSender("A <a@example.com>\r\nBcc: x@example.com")).toBe(false);
  });

  it("parses the form input and trims it", () => {
    expect(smtpSettingsInput.parse({ ...valid, host: "  smtp.example.com ", user: " bot@example.com " })).toMatchObject({
      host: "smtp.example.com",
      user: "bot@example.com",
    });
  });

  it("rejects a missing host, a bad port and an unknown encryption mode", () => {
    expect(smtpSettingsInput.safeParse({ ...valid, host: " " }).success).toBe(false);
    for (const port of [0, 65536, 25.5, Number.NaN]) {
      expect(smtpSettingsInput.safeParse({ ...valid, port }).success, String(port)).toBe(false);
    }
    expect(smtpSettingsInput.safeParse({ ...valid, security: "ssl" }).success).toBe(false);
  });
});
