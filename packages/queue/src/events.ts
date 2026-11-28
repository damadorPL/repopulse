/**
 * Real-time event contract between `apps/worker` (publisher) and `apps/web` (SSE endpoint and
 * browser listener). Browser-safe: no Node or Redis imports, so client components can import
 * it via `@repopulse/queue/events`.
 */

/** Redis Pub/Sub channel carrying one user's events. */
export function userEventsChannel(userId: string): string {
  return `user:${userId}:events`;
}

export type SyncFailureReason = "NOT_FOUND" | "RATE_LIMITED" | "ERROR";

export type RealtimeEvent =
  /** A newly discovered release that was fanned out to this user as unread. */
  | {
      type: "NEW_RELEASE";
      repositoryId: string;
      repositoryName: string;
      tagName: string;
      releaseId: string;
    }
  /** A manual sync was queued (sent to the user who clicked "Sync now"). */
  | { type: "SYNC_STARTED"; repositoryId: string; repositoryName: string }
  /** A manual sync finished. `newReleases` counts releases that became unread for this user. */
  | {
      type: "SYNC_COMPLETED";
      repositoryId: string;
      repositoryName: string;
      result: "NOT_MODIFIED" | "UPDATED";
      newReleases: number;
    }
  /** A manual sync could not complete. `RATE_LIMITED` syncs are retried automatically. */
  | {
      type: "SYNC_FAILED";
      repositoryId: string;
      repositoryName: string;
      reason: SyncFailureReason;
      message: string;
    }
  /**
   * Older releases were imported in the background (sent to every subscriber). History is stored as
   * read, so clients refresh quietly: no "new release" toast.
   */
  | { type: "HISTORY_BACKFILLED"; repositoryId: string; repositoryName: string; added: number }
  /** Slice 08: a dependency scan finished (sent to the project owner). */
  | { type: "DEPS_SCAN_COMPLETED"; projectId: string; fullName: string; outdated: number; majors: number }
  /** Slice 08: a manual dependency scan failed. `message` is user-safe. */
  | { type: "DEPS_SCAN_FAILED"; projectId: string; fullName: string; message: string }
  /** Slice 08: an update pull request was opened, updated, merged, closed or edited by someone else. */
  | {
      type: "DEPS_PULL_REQUEST_UPDATED";
      projectId: string;
      fullName: string;
      groupKey: string;
      state: "OPEN" | "MERGED" | "CLOSED" | "EDITED" | "FAILED";
      number: number | null;
      htmlUrl: string | null;
      /** User-safe reason when `state = FAILED`. */
      message?: string;
    };

export function serializeRealtimeEvent(event: RealtimeEvent): string {
  return JSON.stringify(event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

type PrEventState = Extract<RealtimeEvent, { type: "DEPS_PULL_REQUEST_UPDATED" }>["state"];
const PR_EVENT_STATES: ReadonlySet<string> = new Set<PrEventState>(["OPEN", "MERGED", "CLOSED", "EDITED", "FAILED"]);

function isPrEventState(value: unknown): value is PrEventState {
  return typeof value === "string" && PR_EVENT_STATES.has(value);
}

/**
 * Parses and validates a serialized event, reconstructing a clean object with only known fields.
 * Returns `null` for anything malformed or unknown.
 */
export function parseRealtimeEvent(raw: string): RealtimeEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;

  if (value.type.startsWith("DEPS_")) return parseDepsEvent(value);
  if (typeof value.repositoryId !== "string" || typeof value.repositoryName !== "string") return null;

  const { repositoryId, repositoryName } = value;
  switch (value.type) {
    case "NEW_RELEASE":
      if (typeof value.tagName !== "string" || typeof value.releaseId !== "string") return null;
      return { type: "NEW_RELEASE", repositoryId, repositoryName, tagName: value.tagName, releaseId: value.releaseId };
    case "SYNC_STARTED":
      return { type: "SYNC_STARTED", repositoryId, repositoryName };
    case "SYNC_COMPLETED":
      if (
        (value.result !== "NOT_MODIFIED" && value.result !== "UPDATED") ||
        typeof value.newReleases !== "number" ||
        !Number.isFinite(value.newReleases)
      ) {
        return null;
      }
      return {
        type: "SYNC_COMPLETED",
        repositoryId,
        repositoryName,
        result: value.result,
        newReleases: value.newReleases,
      };
    case "SYNC_FAILED":
      if (
        (value.reason !== "NOT_FOUND" && value.reason !== "RATE_LIMITED" && value.reason !== "ERROR") ||
        typeof value.message !== "string"
      ) {
        return null;
      }
      return { type: "SYNC_FAILED", repositoryId, repositoryName, reason: value.reason, message: value.message };
    case "HISTORY_BACKFILLED":
      if (typeof value.added !== "number" || !Number.isFinite(value.added)) return null;
      return { type: "HISTORY_BACKFILLED", repositoryId, repositoryName, added: value.added };
    default:
      return null;
  }
}

/** Slice 08: the `DEPS_*` events carry a project instead of a repository. */
function parseDepsEvent(value: Record<string, unknown>): RealtimeEvent | null {
  if (typeof value.projectId !== "string" || typeof value.fullName !== "string") return null;
  const { projectId, fullName } = value;
  switch (value.type) {
    case "DEPS_SCAN_COMPLETED":
      if (!isCount(value.outdated) || !isCount(value.majors)) return null;
      return { type: "DEPS_SCAN_COMPLETED", projectId, fullName, outdated: value.outdated, majors: value.majors };
    case "DEPS_SCAN_FAILED":
      if (typeof value.message !== "string") return null;
      return { type: "DEPS_SCAN_FAILED", projectId, fullName, message: value.message };
    case "DEPS_PULL_REQUEST_UPDATED": {
      if (
        typeof value.groupKey !== "string" ||
        !isPrEventState(value.state) ||
        (value.number !== null && !isCount(value.number)) ||
        (value.htmlUrl !== null && typeof value.htmlUrl !== "string") ||
        (value.message !== undefined && typeof value.message !== "string")
      ) {
        return null;
      }
      return {
        type: "DEPS_PULL_REQUEST_UPDATED",
        projectId,
        fullName,
        groupKey: value.groupKey,
        state: value.state,
        number: value.number,
        htmlUrl: value.htmlUrl,
        ...(value.message !== undefined ? { message: value.message } : {}),
      };
    }
    default:
      return null;
  }
}
