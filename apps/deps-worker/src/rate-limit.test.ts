import { describe, expect, it } from "vitest";
import { rateLimitDelayMs } from "./rate-limit";

describe("rateLimitDelayMs", () => {
  const now = new Date("2026-11-05T12:00:00Z");

  it("defaults to 60s when resetAt is null", () => {
    expect(rateLimitDelayMs(null, now)).toBe(60_000);
  });

  it("adds 1s margin and clamps to [5s, 1h]", () => {
    expect(rateLimitDelayMs(new Date(now.getTime() + 10_000), now)).toBe(11_000);
    expect(rateLimitDelayMs(new Date(now.getTime() - 5_000), now)).toBe(5_000);
    expect(rateLimitDelayMs(new Date(now.getTime() + 1_000), now)).toBe(5_000);
    expect(rateLimitDelayMs(new Date(now.getTime() + 2 * 3600_000), now)).toBe(3600_000);
  });
});
