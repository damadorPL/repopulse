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

export type RealtimeEventType = RealtimeEvent["type"];

export function serializeRealtimeEvent(event: RealtimeEvent): string {
  return JSON.stringify(event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "string");
}

/** Parses and validates a serialized event. Returns `null` for anything malformed or unknown. */
export function parseRealtimeEvent(raw: string): RealtimeEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;

  if (value.type.startsWith("DEPS_")) return parseDepsEvent(value);
  if (!hasStrings(value, ["repositoryId", "repositoryName"])) return null;

  switch (value.type) {
    case "NEW_RELEASE":
      return hasStrings(value, ["tagName", "releaseId"]) ? (value as RealtimeEvent) : null;
    case "SYNC_STARTED":
      return value as RealtimeEvent;
    case "SYNC_COMPLETED":
      return (value.result === "NOT_MODIFIED" || value.result === "UPDATED") &&
        typeof value.newReleases === "number" &&
        Number.isFinite(value.newReleases)
        ? (value as RealtimeEvent)
        : null;
    case "SYNC_FAILED":
      return (value.reason === "NOT_FOUND" || value.reason === "RATE_LIMITED" || value.reason === "ERROR") &&
        typeof value.message === "string"
        ? (value as RealtimeEvent)
        : null;
    case "HISTORY_BACKFILLED":
      return typeof value.added === "number" && Number.isFinite(value.added) ? (value as RealtimeEvent) : null;
    default:
      return null;
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const PR_EVENT_STATES = new Set(["OPEN", "MERGED", "CLOSED", "EDITED", "FAILED"]);

/** Slice 08: the `DEPS_*` events carry a project instead of a repository. */
function parseDepsEvent(value: Record<string, unknown>): RealtimeEvent | null {
  if (!hasStrings(value, ["projectId", "fullName"])) return null;
  switch (value.type) {
    case "DEPS_SCAN_COMPLETED":
      return isCount(value.outdated) && isCount(value.majors) ? (value as RealtimeEvent) : null;
    case "DEPS_SCAN_FAILED":
      return typeof value.message === "string" ? (value as RealtimeEvent) : null;
    case "DEPS_PULL_REQUEST_UPDATED":
      return typeof value.groupKey === "string" &&
        typeof value.state === "string" &&
        PR_EVENT_STATES.has(value.state) &&
        (value.number === null || isCount(value.number)) &&
        (value.htmlUrl === null || typeof value.htmlUrl === "string") &&
        (value.message === undefined || typeof value.message === "string")
        ? (value as RealtimeEvent)
        : null;
    default:
      return null;
  }
}
