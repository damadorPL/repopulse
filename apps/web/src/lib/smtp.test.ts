import { describe, expect, it } from "vitest";
import { isValidSmtpHost } from "./smtp";

describe("isValidSmtpHost", () => {
  it("accepts host names and IP addresses, not URLs or host:port", () => {
    for (const host of ["smtp.example.com", "mail", "relay.internal.lan", "10.0.0.5", "::1", "[2001:db8::1]"]) {
      expect({ host, valid: isValidSmtpHost(host) }).toEqual({ host, valid: true });
    }
    for (const host of [
      "smtp://smtp.example.com",
      "smtp.example.com:587",
      "smtp example.com",
      "-bad.example.com",
      "",
    ]) {
      expect({ host, valid: isValidSmtpHost(host) }).toEqual({ host, valid: false });
    }
  });
});
