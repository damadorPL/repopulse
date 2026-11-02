import { describe, expect, it } from "vitest";
import { NOTE_MAX_LENGTH, snoozeUntil, subscriptionSettingsInput, validateSnooze } from "./subscription-settings";

const parse = (input: Record<string, unknown>) => subscriptionSettingsInput.safeParse({ subscriptionId: "sub_1", ...input });

describe("subscriptionSettingsInput", () => {
  it("requires at least one field besides the subscription", () => {
    expect(parse({}).success).toBe(false);
    expect(parse({ isPinned: true }).success).toBe(true);
  });

  it("rejects unknown fields (strict)", () => {
    expect(parse({ isPinned: true, userId: "someone_else" }).success).toBe(false);
  });

  it("normalizes the note: blank clears it, CRLF becomes LF, the length is capped", () => {
    expect(parse({ note: "  " }).data?.note).toBeNull();
    expect(parse({ note: "line 1\r\nline 2  \n" }).data?.note).toBe("line 1\nline 2");
    expect(parse({ note: null }).data?.note).toBeNull();
    expect(parse({ note: "x".repeat(NOTE_MAX_LENGTH + 1) }).success).toBe(false);
  });

  it("validates the version loosely as a tag name; blank clears it", () => {
    expect(parse({ currentVersion: " v2.4.1 " }).data?.currentVersion).toBe("v2.4.1");
    expect(parse({ currentVersion: "@scope/pkg@1.0.0" }).data?.currentVersion).toBe("@scope/pkg@1.0.0");
    expect(parse({ currentVersion: "" }).data?.currentVersion).toBeNull();
    expect(parse({ currentVersion: "has space" }).success).toBe(false);
    expect(parse({ currentVersion: "v1..2" }).success).toBe(false);
    expect(parse({ currentVersion: "v1~2" }).success).toBe(false);
    expect(parse({ currentVersion: "v".repeat(101) }).success).toBe(false);
  });

  it("accepts the four notification levels only", () => {
    expect(parse({ notificationLevel: "MAJOR_ONLY" }).success).toBe(true);
    expect(parse({ notificationLevel: "SOME" }).success).toBe(false);
  });

  it("parses the snooze end as a date, null ends it", () => {
    expect(parse({ snoozedUntil: "2026-11-09T12:00:00.000Z" }).data?.snoozedUntil).toEqual(new Date("2026-11-09T12:00:00.000Z"));
    expect(parse({ snoozedUntil: null }).data?.snoozedUntil).toBeNull();
    expect(parse({ snoozedUntil: "tomorrow-ish" }).success).toBe(false);
  });
});

describe("validateSnooze", () => {
  const now = new Date("2026-11-02T12:00:00Z");

  it("needs a time in the future, at most a year ahead", () => {
    expect(validateSnooze(snoozeUntil(7, now), now)).toBeNull();
    expect(validateSnooze(now, now)).toMatch(/future/);
    expect(validateSnooze(snoozeUntil(400, now), now)).toMatch(/year/);
  });
});
