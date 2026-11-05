import { describe, expect, it } from "vitest";
import { DEFAULT_DEPS_SCAN_CRON } from "@repopulse/queue";
import { DEFAULT_SANDBOX_URL, readConfig } from "./config";

describe("readConfig", () => {
  it("returns defaults when env variables are absent or blank", () => {
    expect(readConfig({})).toEqual({
      scanCron: DEFAULT_DEPS_SCAN_CRON,
      scanConcurrency: 3,
      updateConcurrency: 1,
      sandboxUrl: DEFAULT_SANDBOX_URL,
      sandboxToken: null,
    });
    expect(readConfig({ DEPS_SANDBOX_TOKEN: "   ", DEPS_SCAN_CONCURRENCY: "  " })).toMatchObject({
      scanConcurrency: 3,
      sandboxToken: null,
    });
  });

  it("reads overrides and strips trailing slashes from DEPS_SANDBOX_URL", () => {
    expect(
      readConfig({
        DEPS_SCAN_CRON: "0 * * * *",
        DEPS_SCAN_CONCURRENCY: "5",
        DEPS_UPDATE_CONCURRENCY: "2",
        DEPS_SANDBOX_URL: "https://sandbox.internal:3003///",
        DEPS_SANDBOX_TOKEN: " secret-token ",
      }),
    ).toEqual({
      scanCron: "0 * * * *",
      scanConcurrency: 5,
      updateConcurrency: 2,
      sandboxUrl: "https://sandbox.internal:3003",
      sandboxToken: "secret-token",
    });
  });

  it("rejects non-http(s) or malformed DEPS_SANDBOX_URL and non-positive concurrency values", () => {
    expect(() => readConfig({ DEPS_SANDBOX_URL: "not a url" })).toThrow(/Invalid DEPS_SANDBOX_URL/);
    expect(() => readConfig({ DEPS_SANDBOX_URL: "ftp://sandbox:3003" })).toThrow(/DEPS_SANDBOX_URL must be http\(s\)/);
    for (const bad of ["0", "-1", "2.5", "abc"]) {
      expect(() => readConfig({ DEPS_SCAN_CONCURRENCY: bad }), bad).toThrow(/Invalid DEPS_SCAN_CONCURRENCY/);
      expect(() => readConfig({ DEPS_UPDATE_CONCURRENCY: bad }), bad).toThrow(/Invalid DEPS_UPDATE_CONCURRENCY/);
    }
  });
});
