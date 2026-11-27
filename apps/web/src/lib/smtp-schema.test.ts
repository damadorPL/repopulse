import { describe, expect, it } from "vitest";
import { isValidSender, smtpSettingsInput } from "./smtp-schema";

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
  it("accepts a sender address with or without a display name", () => {
    expect(isValidSender("releases@example.com")).toBe(true);
    expect(isValidSender("RepoPulse <releases@example.com>")).toBe(true);
    expect(isValidSender("RepoPulse")).toBe(false);
    expect(isValidSender("RepoPulse <not-an-address>")).toBe(false);
    expect(isValidSender("A <a@example.com>\r\nBcc: x@example.com")).toBe(false);
  });

  it("parses the form input and trims it", () => {
    expect(smtpSettingsInput.parse({ ...valid, host: "  smtp.example.com ", user: " bot@example.com " })).toMatchObject(
      {
        host: "smtp.example.com",
        user: "bot@example.com",
      },
    );
  });

  it("rejects a missing host, a bad port and an unknown encryption mode", () => {
    expect(smtpSettingsInput.safeParse({ ...valid, host: " " }).success).toBe(false);
    for (const port of [0, 65536, 25.5, Number.NaN]) {
      expect({ port, success: smtpSettingsInput.safeParse({ ...valid, port }).success }).toEqual({
        port,
        success: false,
      });
    }
    expect(smtpSettingsInput.safeParse({ ...valid, security: "ssl" }).success).toBe(false);
  });
});
