"use client";

import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import { useTheme } from "@/components/theme/theme-provider";

type ToasterStyle = CSSProperties & Record<`--${string}`, string>;

const TOASTER_STYLE: ToasterStyle = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
};

function Toaster(props: ToasterProps) {
  const { theme } = useTheme();
  return <Sonner theme={theme} className="group" style={TOASTER_STYLE} {...props} />;
}

export { Toaster };
