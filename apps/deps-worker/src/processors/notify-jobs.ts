import { createHash } from "node:crypto";
import type { Queue } from "bullmq";
import type { NotificationLevel, PrismaClient } from "@repopulse/db";
import { isDeliverableChannel } from "@repopulse/notifications";
import {
  DEPS_JOB_NAMES,
  depsNotifyJobId,
  publishUserEvent,
  type DepsNotifyJobData,
  type RealtimeEvent,
  type Redis,
} from "@repopulse/queue";
import { createLogger } from "../logger";

const log = createLogger("deps-notify");

type SemverLevel = "MAJOR" | "MINOR" | "PATCH" | "PRERELEASE" | "OTHER";

/**
 * Same semantics as Slice 07 `passesNotificationLevel` (`apps/worker/src/processors/fan-out.ts`), applied to an
 * update's `level`: `MINOR_AND_UP` skips patch / pre-release / other, `MAJOR_ONLY` keeps majors, `NONE` nothing.
 * Copied rather than imported: the deps module must not depend on the release worker.
 */
export function passesDependencyNotificationLevel(level: NotificationLevel | undefined, updateLevel: SemverLevel | null): boolean {
  const semverType = updateLevel ?? "OTHER";
  const isPrerelease = semverType === "PRERELEASE";
  switch (level ?? "ALL") {
    case "ALL":
      return true;
    case "NONE":
      return false;
    case "MAJOR_ONLY":
      return !isPrerelease && semverType === "MAJOR";
    case "MINOR_AND_UP":
      return !isPrerelease && (semverType === "MAJOR" || semverType === "MINOR");
  }
}

/** Publishing is best effort: the data is committed, a missed live update is fixed by the next page load. */
export async function publish(redis: Pick<Redis, "publish">, userId: string, event: RealtimeEvent): Promise<void> {
  try {
    await publishUserEvent(redis, userId, event);
  } catch (error) {
    log.error(`could not publish ${event.type} to user ${userId}`, error);
  }
}

export type NotifyQueue = Pick<Queue<DepsNotifyJobData>, "addBulk">;

/** Enabled, untagged, deliverable rules of `userId` that cover `event`. */
export async function rulesFor(
  prisma: PrismaClient,
  userId: string,
  event: "DEPENDENCY_UPDATES" | "DEPENDENCY_PULL_REQUESTS",
): Promise<Array<{ id: string }>> {
  const rules = await prisma.notificationRule.findMany({
    where: { userId, enabled: true, tagId: null, events: { has: event } },
    select: { id: true, channel: true },
  });
  return rules.filter((rule) => isDeliverableChannel(rule.channel)).map((rule) => ({ id: rule.id }));
}

export async function addNotifyJobs(queue: NotifyQueue, jobs: DepsNotifyJobData[], label: string): Promise<void> {
  if (jobs.length === 0) return;
  try {
    await queue.addBulk(jobs.map((data) => ({ name: DEPS_JOB_NAMES.notify, data, opts: { jobId: depsNotifyJobId(data) } })));
  } catch (error) {
    // Not rethrown: the state is committed; a retry could not re-plan these jobs.
    log.error(`${label}: could not enqueue ${jobs.length} notification job(s)`, error);
  }
}

/** Queues one `pull_request` notification per matching rule (opened / updated / edited / access_lost). */
export async function notifyPullRequestEvent(
  deps: { prisma: PrismaClient; notifyQueue: NotifyQueue },
  project: { id: string; userId: string; fullName: string; notificationLevel: NotificationLevel },
  prId: string,
  event: "opened" | "updated" | "edited" | "access_lost",
  dedupKey: string,
): Promise<number> {
  if (project.notificationLevel === "NONE") return 0;
  const rules = await rulesFor(deps.prisma, project.userId, "DEPENDENCY_PULL_REQUESTS");
  await addNotifyJobs(
    deps.notifyQueue,
    rules.map((rule) => ({ ruleId: rule.id, projectId: project.id, kind: "pull_request" as const, prId, event, dedupKey })),
    `${project.fullName} ${event}`,
  );
  return rules.length;
}

/**
 * Deterministic digest id: the same set of (update, target) pairs always maps to the same jobIds, so a retried scan
 * cannot double-send. The target is part of the key because a row keeps its id when a newer target appears: keyed
 * by ids alone, the digest of the new target would collide with the old one (kept 7 days for dedup) and be dropped.
 */
export function digestScanId(projectId: string, updates: ReadonlyArray<{ id: string; targetVersion: string | null }>): string {
  const keys = updates.map((update) => `${update.id}@${update.targetVersion ?? ""}`).sort();
  return createHash("sha1").update(projectId).update("\0").update(keys.join(",")).digest("hex").slice(0, 20);
}
