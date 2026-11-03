import { cache } from "react";
import { INSTANCE_SETTINGS_ID, loadDepsEnabled, prisma } from "@repopulse/db";
import { DEPS_WORKER_HEARTBEAT_KEY, type DepsWorkerHeartbeat } from "@repopulse/deps/limits";
import { isGitHubAppConfigured } from "@/server/queries/github-app";
import { getRedis, isRealtimeConfigured, withRedisTimeout } from "@/server/realtime";

/**
 * Server-only status of the Dependencies module (Slice 08): the admin switch, the sidebar count and
 * the `deps-worker` heartbeat. Not a `"use server"` module.
 */

/** Admin → Dependencies switch. Memoized per request (the layout and the page both ask). */
export const isDepsEnabled = cache(async (): Promise<boolean> => loadDepsEnabled(prisma));

/** The user's projects with at least one `OUTDATED` update (the sidebar badge). */
export async function countOutdatedDependencyProjects(userId: string): Promise<number> {
  return prisma.dependencyProject.count({ where: { userId, updates: { some: { status: "OUTDATED" } } } });
}

export interface DepsSidebarInfo {
  /** `false` hides the "Dependencies" link. */
  enabled: boolean;
  /** Projects of the user with at least one outdated dependency; 0 while disabled. */
  outdatedProjects: number;
}

/** For the dashboard layout: one settings read, plus the count only while the module is on. */
export const getDepsSidebarInfo = cache(async (userId: string): Promise<DepsSidebarInfo> => {
  const enabled = await isDepsEnabled();
  return { enabled, outdatedProjects: enabled ? await countOutdatedDependencyProjects(userId) : 0 };
});

export type DepsWorkerStatus =
  | { state: "running"; at: Date; sandbox: DepsWorkerHeartbeat["sandbox"] }
  /** No heartbeat in Redis: `deps-worker` is not deployed, stopped or stuck (the key expires after 90 s). */
  | { state: "missing" }
  /** Redis is not configured or did not answer, so the status is unknown. */
  | { state: "unknown" };

/** Validates the heartbeat JSON; anything malformed counts as missing. */
export function parseDepsWorkerHeartbeat(raw: string | null): DepsWorkerStatus {
  if (!raw) return { state: "missing" };
  try {
    const value = JSON.parse(raw) as Partial<DepsWorkerHeartbeat> | null;
    const at = typeof value?.at === "string" ? new Date(value.at) : null;
    if (!at || Number.isNaN(at.getTime())) return { state: "missing" };
    const sandbox = value?.sandbox;
    const tools =
      sandbox && typeof sandbox === "object" && sandbox.tools && typeof sandbox.tools === "object"
        ? Object.fromEntries(Object.entries(sandbox.tools).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : null;
    return { state: "running", at, sandbox: tools ? { status: "ok", tools } : null };
  } catch {
    return { state: "missing" };
  }
}

/**
 * Whether lockfile regeneration is available: `deps-worker` is running (fresh heartbeat) and its last probe of the
 * sandbox succeeded. Without it, groups that need a lockfile can't get an update PR (the worker would refuse them).
 */
export function lockfileRegenerationAvailable(status: DepsWorkerStatus): boolean {
  return status.state === "running" && status.sandbox !== null;
}

/** {@link lockfileRegenerationAvailable} for the current heartbeat (Redis down or no heartbeat → `false`). */
export async function readLockfileRegenerationAvailable(): Promise<boolean> {
  return lockfileRegenerationAvailable(await readDepsWorkerStatus());
}

export async function readDepsWorkerStatus(): Promise<DepsWorkerStatus> {
  if (!isRealtimeConfigured()) return { state: "unknown" };
  try {
    return parseDepsWorkerHeartbeat(await withRedisTimeout(getRedis().get(DEPS_WORKER_HEARTBEAT_KEY)));
  } catch {
    return { state: "unknown" };
  }
}

export interface DepsAdminView {
  enabled: boolean;
  worker: DepsWorkerStatus;
  appConfigured: boolean;
  projects: number;
  /** Users with at least one project. */
  users: number;
  outdatedProjects: number;
  openPullRequests: number;
}

/** Admin → Dependencies: instance-wide numbers (super admin only, so no user scope). */
export async function getDepsAdminView(): Promise<DepsAdminView> {
  const [settings, worker, appConfigured, projects, users, outdatedProjects, openPullRequests] = await Promise.all([
    prisma.instanceSettings.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: { depsEnabled: true } }),
    readDepsWorkerStatus(),
    isGitHubAppConfigured(),
    prisma.dependencyProject.count(),
    prisma.user.count({ where: { dependencyProjects: { some: {} } } }),
    prisma.dependencyProject.count({ where: { updates: { some: { status: "OUTDATED" } } } }),
    prisma.dependencyPullRequest.count({ where: { state: "OPEN" } }),
  ]);
  return { enabled: settings?.depsEnabled ?? false, worker, appConfigured, projects, users, outdatedProjects, openPullRequests };
}
