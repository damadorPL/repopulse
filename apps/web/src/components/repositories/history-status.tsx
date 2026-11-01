"use client";

import { useTransition } from "react";
import { HistoryIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { formatWait } from "@/components/repositories/sync-repo-button";
import { Button } from "@/components/ui/button";
import { requestDeepBackfillAction } from "@/server/actions/backfill";
import type { RepositoryHistory } from "@/server/queries/feed";

// UTC, so the server render and the browser agree on the month.
const monthYear = new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" });

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function describe(history: RepositoryHistory, releaseCount: number): string {
  switch (history.status) {
    case "NONE":
      return "History import pending";
    case "QUEUED":
    case "RUNNING":
      return "Importing history…";
    case "PARTIAL":
      return `Partial history: ${plural(releaseCount, "newest release")}`;
    case "ERROR":
      return "History import failed";
    case "DONE":
      if (releaseCount === 0) return "History: no releases yet";
      return `History: ${plural(releaseCount, "release")}${history.oldestAt ? ` since ${monthYear.format(history.oldestAt)}` : ""}`;
  }
}

/**
 * The repository card's history line: backfill status, plus "Load older releases" while GitHub has
 * more and the hard cap is not reached, or "Retry" after a failed import.
 */
export function HistoryStatus({
  repositoryId,
  history,
  releaseCount,
  canLoadOlder,
}: {
  repositoryId: string;
  history: RepositoryHistory;
  releaseCount: number;
  canLoadOlder: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const importing = history.status === "QUEUED" || history.status === "RUNNING";
  const failed = history.status === "ERROR";
  const action = failed ? "Retry" : canLoadOlder ? "Load older releases" : null;

  function request() {
    startTransition(async () => {
      const result = await requestDeepBackfillAction({ repositoryId });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      const { data } = result;
      switch (data.status) {
        case "QUEUED":
          toast.info(`Importing ${data.retry ? "the release history" : "older releases"} of ${data.fullName}…`, {
            description: "They appear in the feed as already read, without notifications.",
          });
          break;
        case "COOLDOWN":
          toast.info(`Older releases of ${data.fullName} were requested recently`, {
            description: `History imports are limited to one every ${data.cooldownMinutes === 1 ? "minute" : `${data.cooldownMinutes} minutes`}. Try again in ${formatWait(data.retryAfterSeconds)}.`,
          });
          break;
        case "IN_PROGRESS":
          toast.info(`The history of ${data.fullName} is already being imported.`);
          break;
        case "COMPLETE":
          toast.info(`The full release history of ${data.fullName} is already imported.`);
          break;
        case "AT_CAP":
          toast.info(`${data.fullName} already holds the maximum of ${data.hardCap} releases.`);
          break;
      }
    });
  }

  return (
    <div className={failed ? "flex items-center gap-1 text-amber-700 dark:text-amber-400" : "flex items-center gap-1"}>
      <dt className="sr-only">History</dt>
      {importing ? (
        <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
      ) : failed ? (
        <TriangleAlertIcon className="size-3.5" aria-hidden />
      ) : (
        <HistoryIcon className="size-3.5" aria-hidden />
      )}
      <dd className="flex items-center gap-1.5">
        {describe(history, releaseCount)}
        {action ? (
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 text-xs"
            onClick={request}
            disabled={pending}
          >
            {pending ? "Requesting…" : action}
          </Button>
        ) : null}
      </dd>
    </div>
  );
}
