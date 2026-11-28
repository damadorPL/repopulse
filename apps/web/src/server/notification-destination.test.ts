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
    await expect(
      normalizeDestination("DISCORD_WEBHOOK", "  https://discord.com/api/webhooks/1/abc ", opts),
    ).resolves.toEqual({
      ok: true,
      data: "https://discord.com/api/webhooks/1/abc",
    });
  });

  it("rejects private, loopback and metadata addresses with a readable message", async () => {
    const results = await Promise.all(
      ["http://127.0.0.1:8080", "http://169.254.169.254/latest/meta-data/", "https://internal.example/hook"].map(
        (url) => normalizeDestination("CUSTOM_WEBHOOK", url, opts),
      ),
    );
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
  });

  it("requires a URL for webhook channels and a token for Gotify", async () => {
    await expect(normalizeDestination("SLACK_WEBHOOK", "  ", opts)).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    await expect(normalizeDestination("GOTIFY_WEBHOOK", "https://gotify.example.com", opts)).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("application token") },
    });
    await expect(normalizeDestination("NTFY_WEBHOOK", "https://nowhere.invalid/topic", opts)).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Could not resolve") },
    });
  });

  it("email: needs SMTP (Admin → Email), takes an optional valid address", async () => {
    await expect(normalizeDestination("EMAIL_INSTANT", "", opts)).resolves.toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
    await expect(normalizeDestination("EMAIL_INSTANT", "", { ...opts, smtpConfigured: false })).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Admin → Email") },
    });
    const smtp = { ...opts, smtpConfigured: true };
    await expect(normalizeDestination("EMAIL_INSTANT", "", smtp)).resolves.toEqual({ ok: true, data: null });
    await expect(normalizeDestination("EMAIL_INSTANT", "team@example.com", smtp)).resolves.toEqual({
      ok: true,
      data: "team@example.com",
    });
    await expect(normalizeDestination("EMAIL_INSTANT", "not-an-email", smtp)).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });
});
