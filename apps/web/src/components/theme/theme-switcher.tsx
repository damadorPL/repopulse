"use client";

import { MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from "lucide-react";
import { THEME_OPTIONS, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useTheme } from "./theme-provider";

const ICONS: Record<ThemePreference, LucideIcon> = { system: MonitorIcon, light: SunIcon, dark: MoonIcon };

/** System / Light / Dark segmented control, shown in the account menu. */
export function ThemeSwitcher({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    <div className={cn("flex items-center justify-between gap-2 px-2 py-1.5", className)}>
      <span id="theme-switcher-label" className="text-sm">
        Theme
      </span>
      <div role="radiogroup" aria-labelledby="theme-switcher-label" className="flex rounded-md border bg-muted p-0.5">
        {THEME_OPTIONS.map(({ value, label }) => {
          const Icon = ICONS[value];
          const selected = theme === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={label}
              title={label}
              onClick={() => setTheme(value)}
              className={cn(
                "flex size-7 items-center justify-center rounded-[calc(var(--radius)-4px)] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3.5",
                selected && "bg-background text-foreground shadow-sm",
              )}
            >
              <Icon />
            </button>
          );
        })}
      </div>
    </div>
  );
}
