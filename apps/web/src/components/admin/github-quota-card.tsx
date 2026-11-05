"use client";

import { useState, useTransition } from "react";
import { AlertTriangleIcon, CheckCircle2Icon, GaugeIcon, LoaderCircleIcon, RefreshCwIcon, ShieldAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { LocalDateTime, RelativeTime } from "@/components/feed/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { refreshGitHubQuotaAction } from "@/server/actions/github-quota";
import type { GitHubQuotaResult } from "@/server/queries/github-quota";

const numberFormat = new Intl.NumberFormat("en");

export function GitHubQuotaCard({
  initialQuota,
  minQuota,
}: {
  initialQuota: GitHubQuotaResult;
  minQuota: number;
}) {
  const [quotaResult, setQuotaResult] = useState<GitHubQuotaResult>(initialQuota);
  const [pending, startTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      const result = await refreshGitHubQuotaAction();
      if (!result.ok) {
        toast.error("Could not refresh GitHub quota", { description: result.error.message });
        setQuotaResult({ ok: false, error: result.error.message });
        return;
      }
      setQuotaResult({ ok: true, data: result.data });
      toast.success("GitHub quota updated", {
        description: `${numberFormat.format(result.data.remaining)} of ${numberFormat.format(result.data.limit)} requests remaining.`,
      });
    });
  }

  if (!quotaResult.ok) {
    return (
      <section aria-labelledby="quota-heading" className="rounded-lg border bg-card p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <GaugeIcon className="size-4 text-muted-foreground" aria-hidden />
            <h3 id="quota-heading" className="font-medium">
              GitHub API quota
            </h3>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={pending}
            className="gap-1.5"
          >
            {pending ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
            Retry
          </Button>
        </div>
        <div className="flex items-start gap-2.5 rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangleIcon className="size-4 shrink-0 mt-0.5" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Could not read GitHub rate limit</p>
            <p className="mt-0.5 text-xs opacity-90">{quotaResult.error}</p>
          </div>
        </div>
      </section>
    );
  }

  const quota = quotaResult.data;
  const isBelowMin = quota.remaining <= minQuota;
  const percentage = quota.limit > 0 ? Math.max(0, Math.min(100, Math.round((quota.remaining / quota.limit) * 100))) : 0;

  return (
    <section aria-labelledby="quota-heading" className="space-y-4 rounded-lg border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <GaugeIcon className="size-4 text-muted-foreground" aria-hidden />
          <h3 id="quota-heading" className="font-medium">
            GitHub API quota
          </h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {quota.authenticated ? (
            <Badge variant="outline" className="text-xs">
              {quota.login ? `@${quota.login}` : "Authenticated"} (5,000/hr)
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-xs">
              Anonymous (60/hr)
            </Badge>
          )}

          {isBelowMin ? (
            <Badge className="gap-1 border-0 bg-amber-500/10 text-amber-700 dark:text-amber-400 text-xs">
              <ShieldAlertIcon className="size-3" aria-hidden />
              Below minimum quota
            </Badge>
          ) : (
            <Badge className="gap-1 border-0 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-xs">
              <CheckCircle2Icon className="size-3" aria-hidden />
              Quota healthy
            </Badge>
          )}

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={refresh}
            disabled={pending}
            title="Refresh GitHub API quota"
            aria-label="Refresh GitHub API quota"
          >
            <RefreshCwIcon className={cn("size-3.5", pending && "animate-spin")} />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border bg-muted/30 p-3">
          <span className="text-xs text-muted-foreground">Remaining quota</span>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tabular-nums">{numberFormat.format(quota.remaining)}</span>
            <span className="text-xs text-muted-foreground tabular-nums">/ {numberFormat.format(quota.limit)}</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
            {numberFormat.format(quota.used)} requests used this hour ({100 - percentage}%)
          </p>
        </div>

        <div className="rounded-md border bg-muted/30 p-3">
          <span className="text-xs text-muted-foreground">Resets at</span>
          <div className="mt-1 text-base font-semibold">
            <LocalDateTime date={quota.resetAt} pattern="p" />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            resets <RelativeTime date={quota.resetAt} />
          </p>
        </div>

        <div className="rounded-md border bg-muted/30 p-3">
          <span className="text-xs text-muted-foreground">Minimum quota threshold</span>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tabular-nums">{numberFormat.format(minQuota)}</span>
            <span className="text-xs text-muted-foreground">requests</span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {isBelowMin ? "Imports paused until reset" : "Imports continue normally"}
          </p>
        </div>
      </div>

      {/* Quota bar */}
      <div className="space-y-1.5">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Capacity remaining</span>
          <span className="tabular-nums font-mono">{percentage}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              "h-full transition-all duration-300",
              isBelowMin ? "bg-rose-500" : percentage < 25 ? "bg-amber-500" : "bg-emerald-500",
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Live rate limit from GitHub for this instance. History backfill jobs automatically pause when the remaining
        quota drops below {numberFormat.format(minQuota)} requests to avoid starving regular polling. Accessing the rate
        limit endpoint does not count against your quota.
      </p>
    </section>
  );
}
