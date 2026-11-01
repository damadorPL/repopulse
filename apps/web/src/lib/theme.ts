/**
 * Color theme preference, stored per browser in the `theme` cookie. The root layout reads it to
 * render `<html data-theme="light|dark">` on the server (no flash of the wrong theme). "system"
 * renders no attribute, so `app/globals.css` follows `prefers-color-scheme`.
 */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_COOKIE = "theme";

/** One year, in seconds. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Unknown or missing values fall back to "system". */
export function parseThemePreference(value: string | undefined | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** The `data-theme` attribute for `<html>`: absent for "system". */
export function themeAttribute(theme: ThemePreference): "light" | "dark" | undefined {
  return theme === "system" ? undefined : theme;
}

/** The `document.cookie` string that stores the preference ("system" clears the cookie). */
export function themeCookieString(theme: ThemePreference): string {
  return theme === "system"
    ? `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
    : `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
}
