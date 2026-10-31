import type { NotificationChannel, SemverType } from "@repopulse/db";
import { INITIAL_RELEASES_LIMIT } from "@repopulse/github";
import type { NotificationJobData } from "@repopulse/queue";

/**
 * Pure decision logic of the repo-poll fan-out, kept free of I/O so it can be unit-tested.
 */

export interface StoredRelease {
  id: string;
  tagName: string;
  isPrerelease: boolean;
  semverType: SemverType;
  publishedAt: Date;
}

export interface FanOutRule {
  id: string;
  /** `null` = the rule applies to every repository. */
  tagId: string | null;
  channel: NotificationChannel;
  onlyMajorReleases: boolean;
}

export interface FanOutSubscriber {
  userId: string;
  includePrereleases: boolean;
  /** Tags the user attached to this subscription. */
  tagIds: string[];
  /** The user's enabled notification rules. */
  rules: FanOutRule[];
}

export interface FanOutPlan {
  /** Unread `UserReleaseState` rows to create. */
  states: Array<{ userId: string; releaseId: string }>;
  /** Releases each user now has unread, newest first (drives the SSE events). */
  deliveries: Array<{ userId: string; releases: StoredRelease[] }>;
  /** Jobs for the `notification-dispatch` queue. */
  notifications: NotificationJobData[];
}

/**
 * The releases that are genuinely new, newest first: inserted by this poll **and** published after
 * the newest release already stored. The poll page (20) is larger than the initial ingest (10), so
 * the first poll of a repository also backfills older releases; those are kept for history but
 * never surface as unread or trigger notifications. With nothing stored yet, every insert is new.
 */
export function selectFreshReleases(created: StoredRelease[], newestKnownAt: Date | null): StoredRelease[] {
  return created
    .filter((release) => newestKnownAt === null || release.publishedAt > newestKnownAt)
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

/**
 * Whether a notification rule fires for a release on a subscription with `tagIds`.
 * In-app delivery is the unread state + SSE event itself, so `IN_APP` rules never queue a job.
 */
export function ruleMatches(rule: FanOutRule, tagIds: readonly string[], release: StoredRelease): boolean {
  if (rule.channel === "IN_APP") return false;
  if (rule.tagId !== null && !tagIds.includes(rule.tagId)) return false;
  if (rule.onlyMajorReleases && release.semverType !== "MAJOR") return false;
  return true;
}

/**
 * Per subscriber: drop pre-releases unless the subscription opts in, cap at `limit` newest (a burst
 * of releases can't flood the feed, and the cap applies *after* filtering so pre-releases can't
 * crowd out a stable one), then plan unread rows, SSE deliveries and notification jobs.
 */
export function planFanOut(
  subscribers: FanOutSubscriber[],
  fresh: StoredRelease[],
  limit = INITIAL_RELEASES_LIMIT,
): FanOutPlan {
  const plan: FanOutPlan = { states: [], deliveries: [], notifications: [] };

  for (const subscriber of subscribers) {
    const visible = fresh
      .filter((release) => subscriber.includePrereleases || !release.isPrerelease)
      .slice(0, limit);
    if (visible.length === 0) continue;

    plan.deliveries.push({ userId: subscriber.userId, releases: visible });
    for (const release of visible) {
      plan.states.push({ userId: subscriber.userId, releaseId: release.id });
      for (const rule of subscriber.rules) {
        if (ruleMatches(rule, subscriber.tagIds, release)) {
          plan.notifications.push({ ruleId: rule.id, releaseId: release.id, userId: subscriber.userId });
        }
      }
    }
  }
  return plan;
}

const MIN_RATE_LIMIT_DELAY_MS = 5_000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;
const MAX_RATE_LIMIT_DELAY_MS = 60 * 60_000;

/**
 * How long to pause the `repo-poll` queue after a GitHub rate-limit response: until
 * `X-RateLimit-Reset` plus 1 s of clock-skew margin, clamped to [5 s, 1 h]. GitHub's reset
 * window is at most an hour; without a header, back off for a minute.
 */
export function rateLimitDelayMs(resetAt: Date | null, now: Date): number {
  const raw = resetAt ? resetAt.getTime() - now.getTime() + 1_000 : DEFAULT_RATE_LIMIT_DELAY_MS;
  return Math.min(Math.max(raw, MIN_RATE_LIMIT_DELAY_MS), MAX_RATE_LIMIT_DELAY_MS);
}
