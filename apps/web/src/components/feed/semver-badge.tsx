import type { SemverTypeValue } from "@/lib/feed-filters";
import { SEMVER_META } from "@/lib/semver-meta";
import { cn } from "@/lib/utils";

export function SemverBadge({ type, className }: { type: SemverTypeValue; className?: string }) {
  const meta = SEMVER_META[type];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[11px] leading-none font-medium",
        meta.className,
        className,
      )}
    >
      {meta.label}
    </span>
  );
}
