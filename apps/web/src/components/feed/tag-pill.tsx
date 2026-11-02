import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Color dot for a user tag (`colorHex` is validated server-side as #RRGGBB). */
export function TagDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/15", className)}
      style={{ backgroundColor: color }}
    />
  );
}

export function TagPill({
  name,
  colorHex,
  className,
  children,
  ...props
}: { name: string; colorHex: string } & ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex max-w-40 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none text-foreground/80",
        className,
      )}
      style={{ borderColor: `${colorHex}55`, backgroundColor: `${colorHex}14` }}
      {...props}
    >
      <TagDot color={colorHex} className="size-1.5" />
      <span className="truncate">{name}</span>
      {/* Trailing controls, e.g. a remove button. */}
      {children}
    </span>
  );
}
