"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLinkIcon, GitPullRequestIcon, LoaderCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/feed/relative-time";
import { SemverBadge } from "@/components/feed/semver-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PR_STATE_LABELS } from "@/lib/dependency-settings";
import type { SemverTypeValue } from "@/lib/feed-filters";
import { cn } from "@/lib/utils";
import { createDependencyPullRequestAction } from "@/server/actions/dependencies";
import type { DependencyPullRequestView, PlannedPullRequest } from "@/server/queries/dependencies";

const SHOWN_UPDATES = 8;

function CreatePrButton({ projectId, plan }: { projectId: string; plan: PlannedPullRequest }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const update = plan.pullRequest?.state === "OPEN";

  function create() {
    startTransition(async () => {
      const result = await createDependencyPullRequestAction({ projectId, groupKey: plan.groupKey });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      toast.info(update ? "Updating the pull request…" : "Opening a pull request…", {
        description: plan.lockfiles.length > 0 ? "Regenerating the lockfile can take a few minutes." : "This takes a moment.",
      });
    });
  }

  return (
    <Button size="sm" variant={update ? "outline" : "default"} onClick={create} disabled={pending || plan.disabledReason !== null}>
      {pending ? <LoaderCircleIcon className="animate-spin" /> : <GitPullRequestIcon />}
      {update ? "Update PR" : "Create PR"}
    </Button>
  );
}

const STATE_TONE: Record<DependencyPullRequestView["state"], string> = {
  OPEN: "border-emerald-300/60 text-emerald-700 dark:text-emerald-300",
  MERGED: "border-violet-300/60 text-violet-700 dark:text-violet-300",
  CLOSED: "text-muted-foreground",
  EDITED: "border-amber-300/60 text-amber-700 dark:text-amber-300",
};

/** Planned update pull requests with "Create PR" / "Update PR", then the PR history (§3.7.3). */
export function PullRequestsSection({
  projectId,
  plans,
  history,
}: {
  projectId: string;
  plans: PlannedPullRequest[];
  history: DependencyPullRequestView[];
}) {
  return (
    <div className="grid gap-5">
      {plans.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to update: no dependency is outdated under your policy.</p>
      ) : (
        <ul className="grid gap-3">
          {plans.map((plan) => (
            <li key={plan.groupKey} className="rounded-md border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <code className="font-mono text-xs">repopulse/deps/{plan.groupKey}</code>
                    {plan.isMajor ? <SemverBadge type="MAJOR" /> : null}
                    {plan.pullRequest ? (
                      <a href={plan.pullRequest.htmlUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs hover:underline">
                        #{plan.pullRequest.number} · {PR_STATE_LABELS[plan.pullRequest.state]}
                        <ExternalLinkIcon className="size-3" aria-hidden />
                      </a>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {plan.updates.length} update{plan.updates.length === 1 ? "" : "s"}
                    {plan.lockfiles.length > 0 ? ` · regenerates ${plan.lockfiles.join(", ")}` : ""}
                  </p>
                </div>
                <CreatePrButton projectId={projectId} plan={plan} />
              </div>
              <ul className="mt-2 grid gap-1 text-xs">
                {plan.updates.slice(0, SHOWN_UPDATES).map((u) => (
                  <li key={`${u.manifestPath}#${u.name}`} className="flex flex-wrap items-center gap-1.5">
                    <code className="font-mono font-medium">{u.name}</code>
                    <span className="text-muted-foreground">
                      {u.from ?? "?"} → <span className="text-foreground">{u.to}</span>
                    </span>
                    {u.level ? <SemverBadge type={u.level as SemverTypeValue} /> : null}
                    <span className="text-muted-foreground">{u.manifestPath}</span>
                  </li>
                ))}
                {plan.updates.length > SHOWN_UPDATES ? (
                  <li className="text-muted-foreground">and {plan.updates.length - SHOWN_UPDATES} more</li>
                ) : null}
              </ul>
              {plan.disabledReason ? <p className="mt-2 text-xs text-muted-foreground">{plan.disabledReason}</p> : null}
            </li>
          ))}
        </ul>
      )}

      {history.length > 0 ? (
        <div>
          <h3 className="text-sm font-medium">History</h3>
          <ul className="mt-2 divide-y rounded-md border text-sm">
            {history.map((pr) => (
              <li key={pr.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <a href={pr.htmlUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium hover:underline">
                  #{pr.number}
                  <ExternalLinkIcon className="size-3" aria-hidden />
                </a>
                <code className="font-mono text-xs text-muted-foreground">{pr.branch}</code>
                <Badge variant="outline" className={cn(STATE_TONE[pr.state])}>
                  {PR_STATE_LABELS[pr.state]}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {pr.targets.length} target{pr.targets.length === 1 ? "" : "s"} · opened <RelativeTime date={pr.openedAt} />
                  {pr.closedAt ? (
                    <>
                      {" "}
                      · {pr.state === "MERGED" ? "merged" : "closed"} <RelativeTime date={pr.closedAt} />
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
