import { describe, expect, it } from "vitest";

import { snoozeUntil, validateSnooze } from "./subscription-settings";

describe("validateSnooze", () => {
  const now = new Date("2026-11-02T12:00:00Z");

  it("needs a time in the future, at most a year ahead", () => {
    expect(validateSnooze(snoozeUntil(7, now), now)).toBeNull();
    expect(validateSnooze(now, now)).toMatch(/future/);
    expect(validateSnooze(snoozeUntil(400, now), now)).toMatch(/year/);
  });
});
