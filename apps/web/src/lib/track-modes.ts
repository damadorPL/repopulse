/**
 * Tracking modes of a subscription, as shown in the add dialog and on repository cards. A local
 * union so client components don't import `@repopulse/db` (it mirrors the `TrackMode` enum).
 */
export type TrackModeValue = "RELEASES" | "TAGS_AND_COMMITS" | "PATHS";

export const TRACK_MODE_OPTIONS: ReadonlyArray<{ value: TrackModeValue; label: string; short: string; hint: string }> = [
  { value: "RELEASES", label: "Releases only", short: "Releases", hint: "GitHub Releases." },
  { value: "TAGS_AND_COMMITS", label: "Releases + tags", short: "Releases + tags", hint: "Also Git tags without a release." },
  { value: "PATHS", label: "Files / folders", short: "Files / folders", hint: "Commits that change specific paths." },
];

export function isTrackMode(value: string): value is TrackModeValue {
  return TRACK_MODE_OPTIONS.some((option) => option.value === value);
}
