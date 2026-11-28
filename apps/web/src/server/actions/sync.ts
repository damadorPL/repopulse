"use server";

import { z } from "zod";

import { prisma } from "@repopulse/db";
import { enqueueDeduplicated, JOB_NAMES, REPO_POLL_PRIORITY, repoPollJobId } from "@repopulse/queue";

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
    const data = { repositoryId, trigger: "manual" as const, requestedByUserId: user.id };

    await withRedisTimeout(
      enqueueDeduplicated({
        queue,
        name: JOB_NAMES.poll,
        data,
        deduplicationId: repoPollJobId(repositoryId),
        priority: REPO_POLL_PRIORITY.manual,
        updateExistingData: true,
      }),
    );

    await publishToUser(user.id, { type: "SYNC_STARTED", repositoryId, repositoryName: fullName });
    return ok({ status: "QUEUED", fullName });
  } catch (error) {
    if (error instanceof RealtimeUnavailableError) return fail("UNAVAILABLE", error.message);
    return toActionError(error, "triggerManualRepoSyncAction");
  }
}
