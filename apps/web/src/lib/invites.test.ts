import { describe, expect, it } from "vitest";
import { generateInviteToken, hashInviteToken } from "@/server/invite-tokens";
import { inviteStatus, isWellFormedInviteToken } from "./invites";

describe("invite tokens", () => {
  it("generates unique, well-formed 256-bit tokens", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
    expect(isWellFormedInviteToken(a)).toBe(true);
  });

  it("hashes deterministically without leaking the token", () => {
    const token = generateInviteToken();
    expect(hashInviteToken(token)).toBe(hashInviteToken(token));
    expect(hashInviteToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken(token)).not.toContain(token);
  });

  it("rejects malformed tokens", () => {
    expect(isWellFormedInviteToken("")).toBe(false);
    expect(isWellFormedInviteToken("short")).toBe(false);
    expect(isWellFormedInviteToken(`${"a".repeat(42)}/`)).toBe(false);
    expect(isWellFormedInviteToken("a".repeat(44))).toBe(false);
  });
});

describe("inviteStatus", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const later = new Date("2026-11-08T12:00:00Z");
  const earlier = new Date("2026-10-25T12:00:00Z");

  it("is pending until it expires", () => {
    expect(inviteStatus({ usedAt: null, expiresAt: later }, now)).toBe("pending");
    expect(inviteStatus({ usedAt: null, expiresAt: earlier }, now)).toBe("expired");
    expect(inviteStatus({ usedAt: null, expiresAt: now }, now)).toBe("expired");
  });

  it("reports used even after the expiry date", () => {
    expect(inviteStatus({ usedAt: earlier, expiresAt: earlier }, now)).toBe("used");
  });
});
