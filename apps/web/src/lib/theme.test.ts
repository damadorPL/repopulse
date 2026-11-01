import { describe, expect, it } from "vitest";
import { parseThemePreference, THEME_COOKIE_MAX_AGE, themeAttribute, themeCookieString } from "./theme";

describe("parseThemePreference", () => {
  it("accepts light and dark", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
  });

  it("falls back to system for missing or unknown values", () => {
    expect(parseThemePreference(undefined)).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("")).toBe("system");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("DARK")).toBe("system");
    expect(parseThemePreference("<script>")).toBe("system");
  });
});

describe("themeAttribute", () => {
  it("omits the attribute for system", () => {
    expect(themeAttribute("system")).toBeUndefined();
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("dark")).toBe("dark");
  });
});

describe("themeCookieString", () => {
  it("stores explicit themes for a year", () => {
    expect(themeCookieString("dark")).toBe(`theme=dark; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`);
  });

  it("clears the cookie for system", () => {
    expect(themeCookieString("system")).toBe("theme=; Path=/; Max-Age=0; SameSite=Lax");
  });
});
