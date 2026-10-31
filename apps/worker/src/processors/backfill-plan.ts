import type { BackfillStatus } from "@repopulse/db";
import type { MappedRelease } from "@repopulse/github";

/**
 * Pure decision logic of the release-history backfill, kept free of I/O so it can be unit-tested.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type BackfillStopReason = "COMPLETE" | "TARGET" | "MAX_AGE";

export interface BackfillStop {
  status: Extract<BackfillStatus, "DONE" | "PARTIAL">;
  reason: BackfillStopReason;
}

/**
 * The status a backfill ends with when the repository holds `target` releases: `PARTIAL` once the
 * hard cap is what stopped it (more history exists but will not be imported), `DONE` otherwise
 * ("Load older releases" can raise the target).
 */
export function targetStop(target: number, hardCap: number): BackfillStop {
  return { status: target >= hardCap ? "PARTIAL" : "DONE", reason: "TARGET" };
}

/** `backfillTarget` clamped to [0, hard cap]. */
export function effectiveTarget(backfillTarget: number, hardCap: number): number {
  return Math.max(0, Math.min(backfillTarget, hardCap));
}

/**
 * `RELEASE_BACKFILL_MAX_AGE_DAYS` limits only the *automatic* backfill. Once a user raised the target
 * past the default ("Load older releases"), they asked for older history, so no age limit applies.
 */
export function maxAgeCutoff(
  config: { maxAgeDays: number; defaultTarget: number },
  target: number,
  now: Date,
): Date | null {
  if (config.maxAgeDays <= 0 || target > config.defaultTarget) return null;
  return new Date(now.getTime() - config.maxAgeDays * DAY_MS);
}

export interface BackfillPageInput {
  page: number;
  /** Published releases on the page, newest first. */
  releases: MappedRelease[];
  hasNextPage: boolean;
  /** `githubReleaseId`s of this page that are already stored. */
  storedIds: ReadonlySet<bigint>;
  /** Releases the repository holds before this page. */
  storedCount: number;
  target: number;
  hardCap: number;
  /**
   * `publishedAt` of the newest stored release. Anything newer is left for repo-poll: it is a
   * genuinely new release that must arrive unread and notify, and the poll only treats releases
   * newer than the newest stored one as new.
   */
  newestKnownAt: Date;
  /** Releases published before this are not imported (automatic backfill only). */
  cutoff: Date | null;
}

export interface BackfillPagePlan {
  /** Rows to insert, newest first. */
  insert: MappedRelease[];
  /**
   * Page to resume from. Stays on the same page when part of it was left out (target reached or
   * releases past the age limit), so a later, larger request picks those up.
   */
  nextPage: number;
  /** Set when the backfill should end after this page. */
  stop: BackfillStop | null;
}

export function planBackfillPage(input: BackfillPageInput): BackfillPagePlan {
  const { page, releases, cutoff } = input;

  const historical = releases.filter((r) => r.publishedAt <= input.newestKnownAt);
  const reachedCutoff = cutoff !== null && historical.some((r) => r.publishedAt < cutoff);
  const inRange = cutoff === null ? historical : historical.filter((r) => r.publishedAt >= cutoff);
  const missing = inRange.filter((r) => !input.storedIds.has(r.githubReleaseId));

  const room = Math.max(0, input.target - input.storedCount);
  const insert = missing.slice(0, room);
  const truncated = missing.length > room;

  const consumedPage = !truncated && !reachedCutoff;
  const nextPage = consumedPage ? page + 1 : page;

  let stop: BackfillStop | null = null;
  if (consumedPage && !input.hasNextPage) {
    stop = { status: "DONE", reason: "COMPLETE" };
  } else if (input.storedCount + insert.length >= input.target) {
    stop = targetStop(input.target, input.hardCap);
  } else if (reachedCutoff) {
    stop = { status: "DONE", reason: "MAX_AGE" };
  }

  return { insert, nextPage, stop };
}
