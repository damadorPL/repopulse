"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@repopulse/db";
import { RELEASE_BACKFILL_PRIORITY } from "@repopulse/queue";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { fail, invalidInput, ok, toActionError, type ActionResult } from "@/server/action-result";
import { enqueueReleaseBackfill } from "@/server/backfill-queue";
import { getBackfillConfig } from "@/server/backfill-settings";
import { RealtimeUnavailableError } from "@/server/realtime";

/**
 * - `QUEUED`: an import job is waiting for the worker. `retry` = a failed or never-started import
 *   was re-queued as is; otherwise the target was raised to `target`.
 * - `COOLDOWN`: another request for this repository was made within the cooldown (Admin → Release history).
 * - `IN_PROGRESS`: an import is already queued or running.
 * - `COMPLETE`: GitHub has no older releases.
 * - `AT_CAP`: the repository already holds the maximum (the hard cap).
 */
export type DeepBackfillResult =
  | { status: "QUEUED"; fullName: string; target: number; retry: boolean }
  | { status: "COOLDOWN"; fullName: string; retryAfterSeconds: number; cooldownMinutes: number }
  | { status: "IN_PROGRESS"; fullName: string }
  | { status: "COMPLETE"; fullName: string }
  | { status: "AT_CAP"; fullName: string; hardCap: number };

const backfillInput = z.object({ repositoryId: z.string().min(1).max(64) });

function retryAfterSeconds(requestedAt: Date, now: number, cooldownMs: number): number {
  return Math.max(1, Math.ceil((requestedAt.getTime() + cooldownMs - now) / 1000));
}

/**
 * "Load older releases": raises the repository's `backfillTarget` by the configured step (up to the
 * hard cap, both in Admin → Release history) and queues a `release-backfill` job. After a failed
 * import it re-queues instead, keeping the target. Subscribers only, at most once per repository
 * per cooldown. Repository history is shared, so the cooldown is shared too.
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
    const { hardCap, deepStep, deepCooldownMinutes } = await getBackfillConfig();
    const cooldownMs = deepCooldownMinutes * 60_000;

    if (repo.backfillStatus === "QUEUED" || repo.backfillStatus === "RUNNING") return ok({ status: "IN_PROGRESS", fullName });

    const retry = repo.backfillStatus === "NONE" || repo.backfillStatus === "ERROR";
    if (!retry) {
      if (repo.backfillStatus === "PARTIAL" || repo.backfillTarget >= hardCap) return ok({ status: "AT_CAP", fullName, hardCap });
      // DONE with no page left to resume from: the whole history is stored.
      if (repo.backfillNextPage === null) return ok({ status: "COMPLETE", fullName });
    }

    const now = Date.now();
    const requestedAt = new Date(now);
    const target = retry ? repo.backfillTarget : Math.min(repo.backfillTarget + deepStep, hardCap);

    const claim = await prisma.repository.updateMany({
      where: {
        id: repositoryId,
        backfillStatus: repo.backfillStatus,
        backfillTarget: repo.backfillTarget,
        OR: [{ backfillRequestedAt: null }, { backfillRequestedAt: { lt: new Date(now - cooldownMs) } }],
      },
      data: { backfillTarget: target, backfillStatus: "QUEUED", backfillRequestedAt: requestedAt },
    });
    if (claim.count === 0) {
      // Lost the claim: still cooling down, or a concurrent request or the worker changed the row.
      const current = await prisma.repository.findUnique({ where: { id: repositoryId }, select: { backfillRequestedAt: true } });
      const last = current?.backfillRequestedAt;
      if (last && now - last.getTime() < cooldownMs) {
        return ok({
          status: "COOLDOWN",
          fullName,
          retryAfterSeconds: retryAfterSeconds(last, now, cooldownMs),
          cooldownMinutes: deepCooldownMinutes,
        });
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
