import { describe, expect, it } from "vitest";
import { isTrackMode, trackingSummary, tracksSomething } from "./track-modes";

describe("isTrackMode", () => {
  it("recognizes valid TrackMode values and rejects others", () => {
    expect(isTrackMode("RELEASES")).toBe(true);
    expect(isTrackMode("TAGS_AND_COMMITS")).toBe(true);
    expect(isTrackMode("NONE")).toBe(true);
    expect(isTrackMode("COMMITS_ONLY")).toBe(false);
    expect(isTrackMode("")).toBe(false);
  });
});

describe("tracksSomething", () => {
  it("requires either a release mode other than NONE or trackPaths=true", () => {
    expect(tracksSomething("RELEASES", false)).toBe(true);
    expect(tracksSomething("TAGS_AND_COMMITS", false)).toBe(true);
    expect(tracksSomething("NONE", true)).toBe(true);
    expect(tracksSomething("NONE", false)).toBe(false);
  });
});

describe("trackingSummary", () => {
  it("formats human-readable summaries of tracked sources and pre-releases", () => {
    expect(trackingSummary("RELEASES", false, false)).toBe("Releases only");
    expect(trackingSummary("TAGS_AND_COMMITS", true, true)).toBe(
      "Releases + tags · Files / folders · Includes pre-releases",
    );
    expect(trackingSummary("NONE", true, true)).toBe("Files / folders");
  });
});
