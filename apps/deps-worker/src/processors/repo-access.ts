import type { PrismaClient } from "@repopulse/db";
import { permissionAtLeast } from "@repopulse/github";
import type { GitHubApi, Octokit } from "../github-api";
import { notifyPullRequestEvent, type NotifyQueue } from "./notify-jobs";

/**
 * The owner's access to a repository (Slice 08 §3.8.4), shared by the scan (read, private repositories) and the
 * update job (write): RepoPulse never takes the installation's word for who may use it.
 */

export interface AccessOwner {
  id: string;
  githubId: string;
  githubLogin: string | null;
}

/**
 * Whether the owner's GitHub login has at least `min` permission on `owner/name`. Logins can change, so a missing
 * login, or a 404 for the stored one, is re-resolved from the immutable `githubId` (and saved) before failing.
 */
export async function ownerHasPermission(
  prisma: PrismaClient,
  github: Pick<GitHubApi, "getCollaboratorPermission" | "getUserLoginById">,
  octokit: Octokit,
  repo: { owner: string; name: string },
  user: AccessOwner,
  min: "read" | "write",
): Promise<boolean> {
  const saveLogin = (login: string) => prisma.user.update({ where: { id: user.id }, data: { githubLogin: login } });
  let login = user.githubLogin;
  if (!login) {
    login = await github.getUserLoginById(octokit, user.githubId);
    if (!login) return false;
    await saveLogin(login);
  }
  let permission = await github.getCollaboratorPermission(octokit, repo.owner, repo.name, login);
  if (permission === null) {
    const fresh = await github.getUserLoginById(octokit, user.githubId);
    if (fresh && fresh !== login) {
      await saveLogin(fresh);
      permission = await github.getCollaboratorPermission(octokit, repo.owner, repo.name, fresh);
    }
  }
  return permissionAtLeast(permission, min);
}

/**
 * The owner lost access: switch the project to notify-only, release its PR ownership (one transaction) and queue
 * the `access_lost` notification. A project already in `NOTIFY` is left as it is (no notification).
 */
export async function revokePullRequestMode(
  deps: { prisma: PrismaClient; notifyQueue: NotifyQueue },
  project: { id: string; userId: string; fullName: string; notificationLevel: Parameters<typeof notifyPullRequestEvent>[1]["notificationLevel"]; updateMode: string },
  prId: string | null,
  at: Date,
): Promise<boolean> {
  if (project.updateMode === "NOTIFY") return false;
  await deps.prisma.$transaction(async (tx) => {
    await tx.dependencyProject.update({ where: { id: project.id }, data: { updateMode: "NOTIFY" } });
    await tx.dependencyPrOwner.deleteMany({ where: { projectId: project.id } });
  });
  await notifyPullRequestEvent(deps, project, prId ?? `project-${project.id}`, "access_lost", `access_lost-${at.getTime()}`);
  return true;
}
