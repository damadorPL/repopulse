"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@repopulse/db";
import { INITIAL_RELEASES_LIMIT, pollRepoReleases } from "@repopulse/github";
import { getCurrentUserOrThrow } from "@/lib/auth";
import { fail, getGitHubToken, invalidInput, ok, toActionError, type ActionResult } from "@/server/action-result";

/** Minimum time between two polls of the same repository (shared by all subscribers). */
const SYNC_COOLDOWN_MS = 5 * 60 * 1000;

export type ManualSyncResult =
  | { status: "COOLDOWN"; fullName: string; retryAfterSeconds: number }
  | { status: "NOT_MODIFIED"; fullName: string }
  | { status: "UPDATED"; fullName: string; newReleases: number };

const syncInput = z.object({ repositoryId: z.string().min(1).max(64) });

/**
 * "Sync Repo Now". Slice 03 polls GitHub inline (conditional `If-None-Match` request, so an
 * unchanged repo costs no quota). Slice 04 replaces the body after the cooldown claim with a
 * priority job on the `repo-poll` BullMQ queue; the signature and result shape stay.
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
      select: { repository: { select: { owner: true, name: true, fullName: true, lastEtag: true } } },
    });
    if (!subscription) return fail("NOT_FOUND", "You are not tracking this repository.");
    const repo = subscription.repository;

    // Atomically claim the poll slot: only one request per cooldown window gets past this,
    // even if several subscribers click at once. `lastPolledAt` marks the attempt, so a
    // failing repo is not hammered either.
    const now = new Date();
    const claimed = await prisma.repository.updateMany({
      where: {
        id: repositoryId,
        OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: new Date(now.getTime() - SYNC_COOLDOWN_MS) } }],
      },
      data: { lastPolledAt: now, pollStatus: "POLLING" },
    });
    if (claimed.count === 0) {
      const current = await prisma.repository.findUnique({ where: { id: repositoryId }, select: { lastPolledAt: true } });
      const elapsed = current?.lastPolledAt ? now.getTime() - current.lastPolledAt.getTime() : 0;
      return ok({
        status: "COOLDOWN",
        fullName: repo.fullName,
        retryAfterSeconds: Math.max(1, Math.ceil((SYNC_COOLDOWN_MS - elapsed) / 1000)),
      });
    }

    try {
      const result = await pollRepoReleases({
        owner: repo.owner,
        name: repo.name,
        lastEtag: repo.lastEtag,
        accessToken: getGitHubToken(user, "triggerManualRepoSyncAction"),
      });

      if (result.status === "NOT_MODIFIED") {
        await prisma.repository.update({ where: { id: repositoryId }, data: { pollStatus: "IDLE", errorCount: 0 } });
        revalidatePath("/", "layout");
        return ok({ status: "NOT_MODIFIED", fullName: repo.fullName });
      }

      const newReleases = await prisma.$transaction(async (tx) => {
        const newestKnown = await tx.release.findFirst({
          where: { repositoryId },
          orderBy: { publishedAt: "desc" },
          select: { publishedAt: true },
        });

        await tx.repository.update({
          where: { id: repositoryId },
          data: { lastEtag: result.etag, pollStatus: "IDLE", errorCount: 0 },
        });

        const created =
          result.releases.length > 0
            ? await tx.release.createManyAndReturn({
                data: result.releases.map((release) => ({ ...release, repositoryId })),
                skipDuplicates: true,
                select: { id: true, isPrerelease: true, publishedAt: true },
              })
            : [];

        // Only releases newer than anything stored are "new". The poll page (20) is larger than
        // the initial ingest (10), so the first sync also backfills older releases — those are
        // stored for history but must not show up as unread.
        const fresh = created
          .filter((r) => !newestKnown || r.publishedAt > newestKnown.publishedAt)
          .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
        if (fresh.length === 0) return 0;

        // Fan out to every subscriber, honoring each subscription's pre-release setting. The cap
        // applies per subscriber after filtering, so a burst of pre-releases can't crowd out a stable one.
        const subscribers = await tx.userSubscription.findMany({
          where: { repositoryId },
          select: { userId: true, includePrereleases: true },
        });
        const states = subscribers.flatMap((sub) =>
          fresh
            .filter((release) => sub.includePrereleases || !release.isPrerelease)
            .slice(0, INITIAL_RELEASES_LIMIT)
            .map((release) => ({ userId: sub.userId, releaseId: release.id })),
        );
        if (states.length > 0) {
          await tx.userReleaseState.createMany({ data: states, skipDuplicates: true });
        }
        return fresh.length;
      });

      revalidatePath("/", "layout");
      return ok({ status: "UPDATED", fullName: repo.fullName, newReleases });
    } catch (error) {
      // Never leave the repository stuck in POLLING.
      await prisma.repository
        .update({ where: { id: repositoryId }, data: { pollStatus: "ERROR", errorCount: { increment: 1 } } })
        .catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return toActionError(error, "triggerManualRepoSyncAction");
  }
}
