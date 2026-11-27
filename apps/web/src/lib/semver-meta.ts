import type { SemverTypeValue } from "@/lib/feed-filters";

export const SEMVER_META: Record<SemverTypeValue, { label: string; short: string; className: string }> = {
  MAJOR: {
    label: "Breaking / Major",
    short: "Major",
    className:
      "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300",
  },
  MINOR: {
    label: "Minor",
    short: "Minor",
    className:
      "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300",
  },
  PATCH: {
    label: "Patch",
    short: "Patch",
    className:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
  },
  PRERELEASE: {
    label: "Pre-release",
    short: "Pre-release",
    className:
      "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
  },
  OTHER: {
    label: "Other",
    short: "Other",
    className:
      "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-500/30 dark:bg-zinc-500/10 dark:text-zinc-300",
  },
};
