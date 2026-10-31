"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { decryptToken, prisma, type User as DbUser } from "@repopulse/db";
import {
  GitHubRateLimitError,
  GitHubRepositoryNotFoundError,
  INITIAL_RELEASES_LIMIT,
  InvalidRepositoryInputError,
  parseRepoInput,
  validateAndFetchRepo,
} from "@repopulse/github";
import { getCurrentUserOrThrow, UnauthorizedError } from "@/lib/auth";

export type ActionErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INTERNAL";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ActionErrorCode; message: string } };

export interface AddRepositoryResult {
  subscriptionId: string;
  repositoryId: string;
  fullName: string;
  releasesCount: number;
}

const addRepositoryInput = z.object({
  repoUrlOrSlug: z.string().trim().min(1, "Enter a repository").max(500),
  includePrereleases: z.boolean().default(false),
  tagIds: z.array(z.string().min(1).max(64)).max(50).default([]),
});

const removeSubscriptionInput = z.object({
  subscriptionId: z.string().min(1).max(64),
});

function fail(code: ActionErrorCode, message: string): ActionResult<never> {
  return { ok: false, error: { code, message } };
}

/**
 * Server Actions run as separate requests, so thrown errors would be redacted in
 * production. Map known errors to serializable results instead.
 */
function toActionError(error: unknown, action: string): ActionResult<never> {
  if (error instanceof UnauthorizedError) return fail("UNAUTHORIZED", error.message);
  if (error instanceof InvalidRepositoryInputError) return fail("INVALID_INPUT", error.message);
  if (error instanceof GitHubRepositoryNotFoundError) return fail("NOT_FOUND", error.message);
  if (error instanceof GitHubRateLimitError) return fail("RATE_LIMITED", error.message);
  console.error(`[${action}] unexpected error`, error);
  return fail("INTERNAL", "Something went wrong. Please try again.");
}

/** Returns the user's GitHub token, or undefined (unauthenticated, 60 req/h) if it can't be decrypted. */
function getGitHubToken(user: DbUser): string | undefined {
  if (!user.githubAccessTokenEncrypted) return undefined;
  try {
    return decryptToken(user.githubAccessTokenEncrypted);
  } catch (error) {
    // e.g. TOKEN_ENCRYPTION_KEY rotated — the next sign-in re-encrypts with the new key.
    console.warn(`[addRepositoryAction] could not decrypt GitHub token for user ${user.id}`, error);
    return undefined;
  }
}

export async function addRepositoryAction(input: {
  repoUrlOrSlug: string;
  includePrereleases: boolean;
  tagIds: string[];
}): Promise<ActionResult<AddRepositoryResult>> {
  try {
    const user = await getCurrentUserOrThrow();

    const parsed = addRepositoryInput.safeParse(input);
    if (!parsed.success) {
      return fail("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const { repoUrlOrSlug, includePrereleases, tagIds } = parsed.data;
    const { owner, name } = parseRepoInput(repoUrlOrSlug);

    // GitHub slugs are case-insensitive ("CoolLabsIO/Coolify" === "coollabsio/coolify").
    const existing = await prisma.repository.findFirst({
      where: { fullName: { equals: `${owner}/${name}`, mode: "insensitive" } },
      select: { id: true, fullName: true, _count: { select: { releases: true } } },
    });

    // Fetch from GitHub before opening the transaction so no DB connection is held during network I/O.
    const fetched =
      !existing || existing._count.releases === 0
        ? await validateAndFetchRepo(owner, name, getGitHubToken(user))
        : null;

    const result = await prisma.$transaction(async (tx) => {
      let repository: { id: string; fullName: string };

      if (fetched) {
        const { repository: repo, releases, etag } = fetched;
        const fields = {
          owner: repo.owner,
          name: repo.name,
          fullName: repo.fullName,
          description: repo.description,
          avatarUrl: repo.avatarUrl,
          htmlUrl: repo.htmlUrl,
          starsCount: repo.starsCount,
          lastEtag: etag,
          lastPolledAt: new Date(),
        };
        // Keyed by the immutable GitHub id so renames/transfers update the same row.
        repository = await tx.repository.upsert({
          where: { githubRepoId: repo.githubRepoId },
          create: { githubRepoId: repo.githubRepoId, ...fields },
          update: fields,
          select: { id: true, fullName: true },
        });
        if (releases.length > 0) {
          await tx.release.createMany({
            data: releases.map((release) => ({ ...release, repositoryId: repository.id })),
            skipDuplicates: true,
          });
        }
      } else {
        repository = { id: existing!.id, fullName: existing!.fullName };
      }

      const subscription = await tx.userSubscription.upsert({
        where: { userId_repositoryId: { userId: user.id, repositoryId: repository.id } },
        create: { userId: user.id, repositoryId: repository.id, includePrereleases },
        update: { includePrereleases },
        select: { id: true },
      });

      if (tagIds.length > 0) {
        // Only attach tags owned by this user.
        const ownedTags = await tx.tag.findMany({
          where: { id: { in: tagIds }, userId: user.id },
          select: { id: true },
        });
        if (ownedTags.length > 0) {
          await tx.subscriptionTag.createMany({
            data: ownedTags.map((tag) => ({ subscriptionId: subscription.id, tagId: tag.id })),
            skipDuplicates: true,
          });
        }
      }

      // Seed the feed with the latest releases (unread), honoring includePrereleases
      // the same way the worker does for newly discovered releases.
      const latestReleases = await tx.release.findMany({
        where: {
          repositoryId: repository.id,
          isDraft: false,
          ...(includePrereleases ? {} : { isPrerelease: false }),
        },
        orderBy: { publishedAt: "desc" },
        take: INITIAL_RELEASES_LIMIT,
        select: { id: true },
      });
      if (latestReleases.length > 0) {
        await tx.userReleaseState.createMany({
          data: latestReleases.map((release) => ({ userId: user.id, releaseId: release.id })),
          skipDuplicates: true,
        });
      }

      const releasesCount = await tx.release.count({ where: { repositoryId: repository.id } });

      return {
        subscriptionId: subscription.id,
        repositoryId: repository.id,
        fullName: repository.fullName,
        releasesCount,
      };
    });

    revalidatePath("/");
    return { ok: true, data: result };
  } catch (error) {
    return toActionError(error, "addRepositoryAction");
  }
}

export async function removeSubscriptionAction(input: {
  subscriptionId: string;
}): Promise<ActionResult<{ subscriptionId: string }>> {
  try {
    const user = await getCurrentUserOrThrow();

    const parsed = removeSubscriptionInput.safeParse(input);
    if (!parsed.success) {
      return fail("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid input");
    }
    const { subscriptionId } = parsed.data;

    const subscription = await prisma.userSubscription.findFirst({
      where: { id: subscriptionId, userId: user.id },
      select: { id: true, repositoryId: true },
    });
    if (!subscription) {
      return fail("NOT_FOUND", "Subscription not found.");
    }

    // The shared Repository/Release rows stay (other users may follow them); only this
    // user's subscription (+ its tag links via cascade) and read states are removed.
    await prisma.$transaction([
      prisma.userReleaseState.deleteMany({
        where: { userId: user.id, release: { repositoryId: subscription.repositoryId } },
      }),
      prisma.userSubscription.delete({ where: { id: subscription.id } }),
    ]);

    revalidatePath("/");
    return { ok: true, data: { subscriptionId: subscription.id } };
  } catch (error) {
    return toActionError(error, "removeSubscriptionAction");
  }
}
