"use client";

import { ChevronDownIcon, ExternalLinkIcon, GitPullRequestIcon, LoaderCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { SemverBadge } from "@/components/feed/semver-badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PR_STATE_LABELS, type DepsUpdateModeValue } from "@/lib/dependency-settings";
import {
  createDependencyPullRequestAction,
  createProjectDependencyPullRequestsAction,
} from "@/server/actions/dependencies";
import type { PlannedPullRequest } from "@/server/queries/dependencies";

function multiGroupTriggerLabel(enabledCount: number, allEnabledOpen: boolean): string {
  if (enabledCount === 1) return allEnabledOpen ? "Update PR" : "Create PR";
  return allEnabledOpen ? `Update PRs (${enabledCount})` : `Create PRs (${enabledCount})`;
}

function SingleGroupButton({
  pending,
  fullName,
  plan,
  onTrigger,
}: {
  pending: boolean;
  fullName: string;
  plan: PlannedPullRequest;
  onTrigger: (plan: PlannedPullRequest) => void;
}) {
  const isUpdate = plan.pullRequest?.state === "OPEN";
  const button = (
    <Button
      size="sm"
      variant={isUpdate ? "outline" : "default"}
      onClick={() => onTrigger(plan)}
      disabled={pending || plan.disabledReason !== null}
      aria-label={`${isUpdate ? "Update" : "Create"} pull request for ${fullName}`}
    >
      {pending ? <LoaderCircleIcon className="motion-safe:animate-spin" /> : <GitPullRequestIcon />}
      {isUpdate ? "Update PR" : "Create PR"}
    </Button>
  );
  return plan.disabledReason !== null ? (
    <span title={plan.disabledReason} className="inline-flex">
      {button}
    </span>
  ) : (
    button
  );
}

function PlannedPullRequestRow({
  plan,
  pending,
  onTrigger,
}: {
  plan: PlannedPullRequest;
  pending: boolean;
  onTrigger: (plan: PlannedPullRequest) => void;
}) {
  const isUpdate = plan.pullRequest?.state === "OPEN";
  const singleUpdate = plan.updates.length === 1 ? plan.updates[0] : null;
  const actionButton = (
    <Button
      size="sm"
      variant={isUpdate ? "outline" : "secondary"}
      onClick={() => onTrigger(plan)}
      disabled={pending || plan.disabledReason !== null}
    >
      {isUpdate ? "Update" : "Create"}
    </Button>
  );

  return (
    <li className="flex items-start justify-between gap-2 py-2.5 first:pt-1 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="truncate font-mono text-xs">repopulse/deps/{plan.groupKey}</code>
          {plan.isMajor ? <SemverBadge type="MAJOR" /> : null}
          {plan.pullRequest ? (
            <a
              href={plan.pullRequest.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              #{plan.pullRequest.number} · {PR_STATE_LABELS[plan.pullRequest.state]}
              <ExternalLinkIcon className="size-3" aria-hidden />
            </a>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {singleUpdate
            ? `${singleUpdate.name} ${singleUpdate.from ?? "?"} → ${singleUpdate.to}`
            : `${plan.updates.length} updates`}
          {plan.lockfiles.length > 0 ? ` · regenerates ${plan.lockfiles.join(", ")}` : ""}
        </p>
        {plan.disabledReason ? <p className="mt-0.5 text-xs text-muted-foreground">{plan.disabledReason}</p> : null}
      </div>
      {plan.disabledReason !== null ? (
        <span title={plan.disabledReason} className="inline-flex shrink-0">
          {actionButton}
        </span>
      ) : (
        <div className="shrink-0">{actionButton}</div>
      )}
    </li>
  );
}

function MultiGroupPullRequestPopover({
  fullName,
  plans,
  enabledPlans,
  pending,
  open,
  onOpenChange,
  onQueueGroup,
  onQueueAll,
}: {
  fullName: string;
  plans: PlannedPullRequest[];
  enabledPlans: PlannedPullRequest[];
  pending: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onQueueGroup: (plan: PlannedPullRequest) => void;
  onQueueAll: () => void;
}) {
  const allEnabledOpen = enabledPlans.every((p) => p.pullRequest?.state === "OPEN");

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant={allEnabledOpen ? "outline" : "default"}
          disabled={pending}
          aria-label={`Pull requests for ${fullName}`}
        >
          {pending ? <LoaderCircleIcon className="motion-safe:animate-spin" /> : <GitPullRequestIcon />}
          {multiGroupTriggerLabel(enabledPlans.length, allEnabledOpen)}
          <ChevronDownIcon className="size-3.5" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] p-3">
        <div className="flex items-center justify-between gap-2 pb-2">
          <p className="text-sm font-medium">Planned pull requests</p>
          {enabledPlans.length > 1 ? (
            <Button size="sm" variant={allEnabledOpen ? "outline" : "default"} onClick={onQueueAll} disabled={pending}>
              {allEnabledOpen ? `Update all (${enabledPlans.length})` : `Create all (${enabledPlans.length})`}
            </Button>
          ) : null}
        </div>
        <ul className="max-h-72 divide-y overflow-y-auto">
          {plans.map((plan) => (
            <PlannedPullRequestRow key={plan.groupKey} plan={plan} pending={pending} onTrigger={onQueueGroup} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * "Create PR" / "Update PR" button for a project row on `/dependencies` (single planned group pushes
 * directly; multiple planned groups open a compact chooser with per-group and batch actions).
 */
export function ProjectPullRequestButton({
  projectId,
  fullName,
  updateMode,
  plans,
}: {
  projectId: string;
  fullName: string;
  updateMode: DepsUpdateModeValue;
  plans: PlannedPullRequest[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  if (updateMode === "NOTIFY" || plans.length === 0) return null;

  function queueGroup(plan: PlannedPullRequest) {
    const isUpdate = plan.pullRequest?.state === "OPEN";
    startTransition(async () => {
      const result = await createDependencyPullRequestAction({ projectId, groupKey: plan.groupKey });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      setOpen(false);
      toast.info(isUpdate ? `Updating pull request for ${fullName}…` : `Opening a pull request for ${fullName}…`, {
        description:
          plan.lockfiles.length > 0 ? "Regenerating the lockfile can take a few minutes." : "This takes a moment.",
      });
    });
  }

  function queueAll() {
    const enabled = plans.filter((p) => p.disabledReason === null);
    const hasLockfiles = enabled.some((p) => p.lockfiles.length > 0);
    startTransition(async () => {
      const result = await createProjectDependencyPullRequestsAction({ projectId });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      setOpen(false);
      const count = result.data.groupKeys.length;
      toast.info(
        count === 1 ? `Opening a pull request for ${fullName}…` : `Queueing ${count} pull requests for ${fullName}…`,
        {
          description: hasLockfiles ? "Regenerating lockfiles can take a few minutes." : "This takes a moment.",
        },
      );
    });
  }

  if (plans.length === 1) {
    return <SingleGroupButton pending={pending} fullName={fullName} plan={plans[0]!} onTrigger={queueGroup} />;
  }

  const enabledPlans = plans.filter((p) => p.disabledReason === null);
  if (enabledPlans.length === 0) {
    const allOpen = plans.every((p) => p.pullRequest?.state === "OPEN");
    return (
      <span title={plans[0]?.disabledReason ?? undefined} className="inline-flex">
        <Button size="sm" variant="outline" disabled aria-label={`Pull requests for ${fullName}`}>
          <GitPullRequestIcon />
          {allOpen ? "Update PRs" : "Create PRs"}
        </Button>
      </span>
    );
  }

  return (
    <MultiGroupPullRequestPopover
      fullName={fullName}
      plans={plans}
      enabledPlans={enabledPlans}
      pending={pending}
      open={open}
      onOpenChange={setOpen}
      onQueueGroup={queueGroup}
      onQueueAll={queueAll}
    />
  );
}
