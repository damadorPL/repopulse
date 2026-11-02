/**
 * What a subscription tracks, as shown in the add dialog and on repository cards. Two independent
 * settings: the release mode below, and "Files / folders" (`trackPaths`, commits that change watched
 * paths). At least one of them is on. A local union so client components don't import
 * `@repopulse/db` (it mirrors the `TrackMode` enum).
 */
export type TrackModeValue = "RELEASES" | "TAGS_AND_COMMITS" | "NONE";

export const TRACK_MODE_OPTIONS: ReadonlyArray<{ value: TrackModeValue; label: string; short: string; hint: string }> = [
  { value: "RELEASES", label: "Releases only", short: "Releases", hint: "GitHub Releases." },
  { value: "TAGS_AND_COMMITS", label: "Releases + tags", short: "Releases + tags", hint: "Also Git tags without a release." },
  { value: "NONE", label: "No releases", short: "No releases", hint: "Only commits to watched files and folders." },
];

export const PATHS_OPTION = { label: "Files / folders", hint: "Commits that change specific paths." } as const;

export const NOTHING_TRACKED_MESSAGE = "Track releases, files / folders, or both.";

export function isTrackMode(value: string): value is TrackModeValue {
  return TRACK_MODE_OPTIONS.some((option) => option.value === value);
}

/** A subscription must follow something: releases (with or without tags), watched paths, or both. */
export function tracksSomething(trackMode: TrackModeValue, trackPaths: boolean): boolean {
  return trackMode !== "NONE" || trackPaths;
}

/** Read-only summary of what a subscription tracks: `Releases + tags · Files / folders · Includes pre-releases`. */
export function trackingSummary(trackMode: TrackModeValue, trackPaths: boolean, includePrereleases: boolean): string {
  const parts: string[] = [];
  if (trackMode !== "NONE") parts.push(TRACK_MODE_OPTIONS.find((option) => option.value === trackMode)!.label);
  if (trackPaths) parts.push(PATHS_OPTION.label);
  if (includePrereleases && trackMode !== "NONE") parts.push("Includes pre-releases");
  return parts.join(" · ");
}
