import type { NotificationChannel, NotificationEvent, NotificationLevel, SemverType } from "@repopulse/db";
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
  /** What the rule fires for (Slice 08). Release fan-out needs `RELEASES`. */
  events: readonly NotificationEvent[];
}

export interface FanOutSubscriber {
  userId: string;
  includePrereleases: boolean;
  /** Tags the user attached to this subscription. */
  tagIds: string[];
  /** The user's enabled notification rules. */
  rules: FanOutRule[];
  /**
   * Per-repository override checked before the rules (Slice 07). Missing = `ALL` (the rules decide).
   * Only external notifications are affected: unread states and SSE deliveries are planned regardless.
   */
  notificationLevel?: NotificationLevel;
  /** External notifications are skipped while this lies in the future (Slice 07). Not retroactive. */
  snoozedUntil?: Date | null;
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
 * In-app delivery is the unread state + SSE event itself, so `IN_APP` rules never queue a job;
 * neither do `EMAIL_DIGEST` rules, which have no sender yet. A rule that only covers dependency
 * events (Slice 08) never fires for releases.
 */
export function ruleMatches(rule: FanOutRule, tagIds: readonly string[], release: StoredRelease): boolean {
  if (rule.channel === "IN_APP" || rule.channel === "EMAIL_DIGEST") return false;
  if (!rule.events.includes("RELEASES")) return false;
  if (rule.tagId !== null && !tagIds.includes(rule.tagId)) return false;
  if (rule.onlyMajorReleases && release.semverType !== "MAJOR") return false;
  return true;
}

/**
 * Whether a release clears a subscription's notification level. Commits are stored as `OTHER`, so
 * `MINOR_AND_UP` and `MAJOR_ONLY` silence them; pre-releases count as below a minor release.
 */
export function passesNotificationLevel(level: NotificationLevel | undefined, release: StoredRelease): boolean {
  switch (level ?? "ALL") {
    case "ALL":
      return true;
    case "NONE":
      return false;
    case "MAJOR_ONLY":
      return !release.isPrerelease && release.semverType === "MAJOR";
    case "MINOR_AND_UP":
      return !release.isPrerelease && (release.semverType === "MAJOR" || release.semverType === "MINOR");
  }
}

/** A snooze is active while `snoozedUntil` lies strictly in the future. */
export function isSnoozed(snoozedUntil: Date | null | undefined, now: Date): boolean {
  return snoozedUntil != null && snoozedUntil.getTime() > now.getTime();
}

/** Whether the subscription may send external notifications for a release at all (before its rules run). */
export function mayNotify(subscriber: FanOutSubscriber, release: StoredRelease, now: Date): boolean {
  return !isSnoozed(subscriber.snoozedUntil, now) && passesNotificationLevel(subscriber.notificationLevel, release);
}

/**
 * Per subscriber: drop pre-releases unless the subscription opts in, cap at `limit` newest (a burst
 * of releases can't flood the feed, and the cap applies *after* filtering so pre-releases can't
 * crowd out a stable one), then plan unread rows, SSE deliveries and notification jobs. Notification
 * jobs are planned only when the subscription's snooze and notification level allow it ({@link mayNotify}).
 */
export function planFanOut(
  subscribers: FanOutSubscriber[],
  fresh: StoredRelease[],
  limit = INITIAL_RELEASES_LIMIT,
  now: Date = new Date(),
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
      if (!mayNotify(subscriber, release, now)) continue;
      for (const rule of subscriber.rules) {
        if (ruleMatches(rule, subscriber.tagIds, release)) {
          plan.notifications.push({ ruleId: rule.id, releaseId: release.id, userId: subscriber.userId });
        }
      }
    }
  }
  return plan;
}

export const EMPTY_FAN_OUT_PLAN: FanOutPlan = { states: [], deliveries: [], notifications: [] };

/**
 * Combines the plans of the release and tag steps of one poll. A user's deliveries are merged
 * (newest first), so `SYNC_COMPLETED` and the SSE events see one list per user.
 */
export function mergeFanOutPlans(...plans: FanOutPlan[]): FanOutPlan {
  const deliveries = new Map<string, StoredRelease[]>();
  for (const plan of plans) {
    for (const { userId, releases } of plan.deliveries) deliveries.set(userId, [...(deliveries.get(userId) ?? []), ...releases]);
  }
  return {
    states: plans.flatMap((plan) => plan.states),
    deliveries: [...deliveries].map(([userId, releases]) => ({
      userId,
      releases: releases.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime()),
    })),
    notifications: plans.flatMap((plan) => plan.notifications),
  };
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
