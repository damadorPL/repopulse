"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@repopulse/db";
import { DEEP_BACKFILL_COOLDOWN_MS, DEEP_BACKFILL_STEP, RELEASE_BACKFILL_PRIORITY, readBackfillConfig } from "@repopulse/queue";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { fail, invalidInput, ok, toActionError, type ActionResult } from "@/server/action-result";
import { enqueueReleaseBackfill } from "@/server/backfill-queue";
import { RealtimeUnavailableError } from "@/server/realtime";

/**
 * - `QUEUED`: an import job is waiting for the worker. `retry` = a failed or never-started import
 *   was re-queued as is; otherwise the target was raised to `target`.
 * - `COOLDOWN`: another request for this repository was made in the last 5 minutes.
 * - `IN_PROGRESS`: an import is already queued or running.
 * - `COMPLETE`: GitHub has no older releases.
 * - `AT_CAP`: the repository already holds the maximum (`RELEASE_BACKFILL_HARD_CAP`).
 */
export type DeepBackfillResult =
  | { status: "QUEUED"; fullName: string; target: number; retry: boolean }
  | { status: "COOLDOWN"; fullName: string; retryAfterSeconds: number }
  | { status: "IN_PROGRESS"; fullName: string }
  | { status: "COMPLETE"; fullName: string }
  | { status: "AT_CAP"; fullName: string; hardCap: number };

const backfillInput = z.object({ repositoryId: z.string().min(1).max(64) });

function retryAfterSeconds(requestedAt: Date, now: number): number {
  return Math.max(1, Math.ceil((requestedAt.getTime() + DEEP_BACKFILL_COOLDOWN_MS - now) / 1000));
}

/**
 * "Load older releases": raises the repository's `backfillTarget` by {@link DEEP_BACKFILL_STEP}
 * (up to `RELEASE_BACKFILL_HARD_CAP`) and queues a `release-backfill` job. After a failed import it
 * re-queues instead, keeping the target. Subscribers only, at most once per repository every
 * 5 minutes. Repository history is shared, so the cooldown is shared too.
 *
 * The cooldown is an atomic claim: one `updateMany` matching the state that was read plus an
 * expired `backfillRequestedAt`. Of two concurrent clicks, only one updates a row.
 */
export async function requestDeepBackfillAction(input: { repositoryId: string }): Promise<ActionResult<DeepBackfillResult>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = backfillInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { repositoryId } = parsed.data;

    const subscription = await prisma.userSubscription.findUnique({
      where: { userId_repositoryId: { userId: user.id, repositoryId } },
      select: {
        repository: {
          select: {
            fullName: true,
            backfillStatus: true,
            backfillTarget: true,
            backfillNextPage: true,
            backfillRequestedAt: true,
          },
        },
      },
    });
    if (!subscription) return fail("NOT_FOUND", "You are not tracking this repository.");
    const repo = subscription.repository;
    const { fullName } = repo;
    const { hardCap } = readBackfillConfig();

    if (repo.backfillStatus === "QUEUED" || repo.backfillStatus === "RUNNING") return ok({ status: "IN_PROGRESS", fullName });

    const retry = repo.backfillStatus === "NONE" || repo.backfillStatus === "ERROR";
    if (!retry) {
      if (repo.backfillStatus === "PARTIAL" || repo.backfillTarget >= hardCap) return ok({ status: "AT_CAP", fullName, hardCap });
      // DONE with no page left to resume from: the whole history is stored.
      if (repo.backfillNextPage === null) return ok({ status: "COMPLETE", fullName });
    }

    const now = Date.now();
    const requestedAt = new Date(now);
    const target = retry ? repo.backfillTarget : Math.min(repo.backfillTarget + DEEP_BACKFILL_STEP, hardCap);

    const claim = await prisma.repository.updateMany({
      where: {
        id: repositoryId,
        backfillStatus: repo.backfillStatus,
        backfillTarget: repo.backfillTarget,
        OR: [{ backfillRequestedAt: null }, { backfillRequestedAt: { lt: new Date(now - DEEP_BACKFILL_COOLDOWN_MS) } }],
      },
      data: { backfillTarget: target, backfillStatus: "QUEUED", backfillRequestedAt: requestedAt },
    });
    if (claim.count === 0) {
      // Lost the claim: still cooling down, or a concurrent request or the worker changed the row.
      const current = await prisma.repository.findUnique({ where: { id: repositoryId }, select: { backfillRequestedAt: true } });
      const last = current?.backfillRequestedAt;
      if (last && now - last.getTime() < DEEP_BACKFILL_COOLDOWN_MS) {
        return ok({ status: "COOLDOWN", fullName, retryAfterSeconds: retryAfterSeconds(last, now) });
      }
      return ok({ status: "IN_PROGRESS", fullName });
    }

    try {
      await enqueueReleaseBackfill(
        { repositoryId, trigger: retry ? "retry" : "deep" },
        RELEASE_BACKFILL_PRIORITY.requested,
      );
    } catch (error) {
      // Give the claim back, so the user can try again as soon as Redis is reachable.
      await prisma.repository.updateMany({
        where: { id: repositoryId, backfillStatus: "QUEUED", backfillRequestedAt: requestedAt },
        data: { backfillStatus: repo.backfillStatus, backfillTarget: repo.backfillTarget, backfillRequestedAt: repo.backfillRequestedAt },
      });
      throw error;
    }

    revalidatePath("/repositories");
    return ok({ status: "QUEUED", fullName, target, retry });
  } catch (error) {
    if (error instanceof RealtimeUnavailableError) return fail("UNAVAILABLE", error.message);
    return toActionError(error, "requestDeepBackfillAction");
  }
}
