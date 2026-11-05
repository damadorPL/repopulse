import { describe, expect, it } from "vitest";
import { safeCallbackUrl } from "./safe-callback-url";

describe("safeCallbackUrl", () => {
  it("preserves same-origin relative paths with query strings and hashes", () => {
    expect(safeCallbackUrl("/")).toBe("/");
    expect(safeCallbackUrl("/repositories?filter=unread#top")).toBe("/repositories?filter=unread#top");
  });

  it("rejects external origins, protocol-relative URLs, and backslash-prefixed URLs", () => {
    expect(safeCallbackUrl(undefined)).toBe("/");
    expect(safeCallbackUrl("")).toBe("/");
    expect(safeCallbackUrl("https://example.com/")).toBe("/");
    expect(safeCallbackUrl("//example.com/")).toBe("/");
    expect(safeCallbackUrl("/\\example.com")).toBe("/");
    expect(safeCallbackUrl("/foo\\bar")).toBe("/");
  });
});
