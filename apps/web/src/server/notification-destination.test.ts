import { describe, expect, it, vi } from "vitest";
import type { ResolveAll } from "@repopulse/notifications";

// action-result pulls in Auth.js (via UnauthorizedError), which needs the Next runtime.
vi.mock("@/lib/auth", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
}));

const { normalizeDestination } = await import("@/server/notification-destination");

const resolveAll: ResolveAll = async (hostname) => {
  if (hostname === "internal.example") return [{ address: "10.0.0.7", family: 4 }];
  if (hostname === "nowhere.invalid") throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return [{ address: "93.184.216.34", family: 4 }];
};
const opts = { resolveAll, policy: { mode: "none" } as const };

describe("normalizeDestination", () => {
  it("accepts public webhook URLs and normalizes them", async () => {
    expect(await normalizeDestination("DISCORD_WEBHOOK", "  https://discord.com/api/webhooks/1/abc ", opts)).toEqual({
      ok: true,
      data: "https://discord.com/api/webhooks/1/abc",
    });
  });

  it("rejects private, loopback and metadata addresses with a readable message", async () => {
    for (const url of ["http://127.0.0.1:8080", "http://169.254.169.254/latest/meta-data/", "https://internal.example/hook"]) {
      const result = await normalizeDestination("CUSTOM_WEBHOOK", url, opts);
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
  });

  it("requires a URL for webhook channels and a token for Gotify", async () => {
    expect(await normalizeDestination("SLACK_WEBHOOK", "  ", opts)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await normalizeDestination("GOTIFY_WEBHOOK", "https://gotify.example.com", opts)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("application token") },
    });
    expect(await normalizeDestination("NTFY_WEBHOOK", "https://nowhere.invalid/topic", opts)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Could not resolve") },
    });
  });

  it("email: needs SMTP (Settings → Email), takes an optional valid address", async () => {
    expect(await normalizeDestination("EMAIL_INSTANT", "", opts)).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(await normalizeDestination("EMAIL_INSTANT", "", { ...opts, smtpConfigured: false })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Settings → Email") },
    });
    const smtp = { ...opts, smtpConfigured: true };
    expect(await normalizeDestination("EMAIL_INSTANT", "", smtp)).toEqual({ ok: true, data: null });
    expect(await normalizeDestination("EMAIL_INSTANT", "team@example.com", smtp)).toEqual({ ok: true, data: "team@example.com" });
    expect(await normalizeDestination("EMAIL_INSTANT", "not-an-email", smtp)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
});
