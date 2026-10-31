import { describe, expect, it } from "vitest";
import { isHexColor, readableTextColor, slugify, tagSlug } from "./tags";

describe("slugify", () => {
  it.each([
    ["Self-Hosted", "self-hosted"],
    ["Critical", "critical"],
    ["UI Libraries", "ui-libraries"],
    ["  Coolify   Stack  ", "coolify-stack"],
    ["Production Deps!", "production-deps"],
    ["Café & Co.", "cafe-co"],
    ["C++ / Rust", "c-rust"],
    ["v2.0 -- beta", "v2-0-beta"],
  ])("%s → %s", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it("returns an empty string when nothing URL-safe remains", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("🚀")).toBe("");
  });

  it("caps slugs at 64 characters without a trailing dash", () => {
    const slug = slugify(`${"a".repeat(63)} b`);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("isHexColor", () => {
  it.each(["#EF4444", "#ef4444", "#000000", "#FFFFFF"])("accepts %s", (value) => {
    expect(isHexColor(value)).toBe(true);
  });

  it.each(["EF4444", "#EF444", "#EF44444", "#GGGGGG", "red", "#EF4444;", " #EF4444", "url(x)"])("rejects %s", (value) => {
    expect(isHexColor(value)).toBe(false);
  });
});

describe("readableTextColor", () => {
  it("uses dark text on light colors and light text on dark colors", () => {
    expect(readableTextColor("#FDE047")).toBe("#000000");
    expect(readableTextColor("#1E3A8A")).toBe("#FFFFFF");
  });
});

describe("tagSlug", () => {
  it("uses the readable slug when there is one", () => {
    expect(tagSlug("Self-Hosted")).toBe("self-hosted");
  });

  it("falls back to a stable, URL-safe hash for non-Latin names", () => {
    const cyrillic = tagSlug("Фронтенд");
    expect(cyrillic).toMatch(/^tag-[0-9a-z]+$/);
    expect(tagSlug("  Фронтенд ")).toBe(cyrillic);
    expect(tagSlug("前端")).not.toBe(cyrillic);
    expect(tagSlug("🚀")).toMatch(/^tag-[0-9a-z]+$/);
  });
});
