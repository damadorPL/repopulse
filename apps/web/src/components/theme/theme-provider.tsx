"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { themeAttribute, themeCookieString, type ThemePreference } from "@/lib/theme";

type ThemeContextValue = { theme: ThemePreference; setTheme: (theme: ThemePreference) => void };

const ThemeContext = createContext<ThemeContextValue>({ theme: "system", setTheme: () => {} });

/**
 * Holds the theme preference. The root layout renders `data-theme` on `<html>` from the cookie;
 * switching updates the attribute and the cookie directly, with no server round trip.
 */
export function ThemeProvider({ initialTheme, children }: { initialTheme: ThemePreference; children: ReactNode }) {
  const [theme, setThemeState] = useState(initialTheme);

  function setTheme(next: ThemePreference) {
    setThemeState(next);
    const attribute = themeAttribute(next);
    if (attribute) document.documentElement.dataset.theme = attribute;
    else delete document.documentElement.dataset.theme;
    document.cookie = themeCookieString(next);
  }

  return <ThemeContext value={{ theme, setTheme }}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
