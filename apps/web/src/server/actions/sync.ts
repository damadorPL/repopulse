"use server";

import { z } from "zod";
import { prisma } from "@repopulse/db";
import { JOB_NAMES, REPO_POLL_PRIORITY, repoPollJobId } from "@repopulse/queue";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { fail, invalidInput, ok, toActionError, type ActionResult } from "@/server/action-result";
import { getRepoPollQueue, publishToUser, RealtimeUnavailableError, withRedisTimeout } from "@/server/realtime";

/** Minimum time between two polls of the same repository (shared by all subscribers). */
const SYNC_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * `QUEUED`: a priority `repo-poll` job is waiting for the worker. Its outcome arrives over SSE
 * as `SYNC_COMPLETED` / `SYNC_FAILED` (plus `NEW_RELEASE` events), addressed to this user.
 */
export type ManualSyncResult =
  | { status: "COOLDOWN"; fullName: string; retryAfterSeconds: number }
  | { status: "QUEUED"; fullName: string };

const syncInput = z.object({ repositoryId: z.string().min(1).max(64) });

/**
 * "Sync Repo Now": enqueues a priority (`priority: 1`) poll on the `repo-poll` queue, at most
 * once per repository every 5 minutes. The worker records every attempt in `lastPolledAt`, so
 * the cooldown also protects a failing repository from repeated clicks.
 */
export async function triggerManualRepoSyncAction(input: {
  repositoryId: string;
}): Promise<ActionResult<ManualSyncResult>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = syncInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { repositoryId } = parsed.data;

    const subscription = await prisma.userSubscription.findUnique({
      where: { userId_repositoryId: { userId: user.id, repositoryId } },
      select: { repository: { select: { fullName: true, lastPolledAt: true } } },
    });
    if (!subscription) return fail("NOT_FOUND", "You are not tracking this repository.");
    const { fullName, lastPolledAt } = subscription.repository;

    const elapsed = lastPolledAt ? Date.now() - lastPolledAt.getTime() : Infinity;
    if (elapsed < SYNC_COOLDOWN_MS) {
      return ok({
        status: "COOLDOWN",
        fullName,
        retryAfterSeconds: Math.max(1, Math.ceil((SYNC_COOLDOWN_MS - elapsed) / 1000)),
      });
    }

    const queue = getRepoPollQueue();
    const jobId = repoPollJobId(repositoryId);
    const data = { repositoryId, trigger: "manual" as const, requestedByUserId: user.id };

    await withRedisTimeout(
      (async () => {
        // The jobId deduplicates against a poll that is already queued (e.g. by the scheduler).
        // BullMQ would silently drop our add, so take that job over instead: bump its priority and
        // address its SYNC_* events to this user. An active job is left alone; its new releases
        // still arrive as NEW_RELEASE events.
        const existing = await queue.getJob(jobId);
        if (!existing) {
          await queue.add(JOB_NAMES.poll, data, { jobId, priority: REPO_POLL_PRIORITY.manual });
          return;
        }
        const state = await existing.getState();
        if (state === "waiting" || state === "prioritized" || state === "delayed") {
          await existing.updateData(data);
          if (state !== "delayed") await existing.changePriority({ priority: REPO_POLL_PRIORITY.manual });
        }
      })(),
    );

    await publishToUser(user.id, { type: "SYNC_STARTED", repositoryId, repositoryName: fullName });
    return ok({ status: "QUEUED", fullName });
  } catch (error) {
    if (error instanceof RealtimeUnavailableError) return fail("UNAVAILABLE", error.message);
    return toActionError(error, "triggerManualRepoSyncAction");
  }
}
