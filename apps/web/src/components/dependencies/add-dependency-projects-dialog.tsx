"use client";

import { LoaderCircleIcon, SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Activity, useDeferredValue, useId, useState, useTransition, type ReactNode, type SubmitEvent } from "react";
import { toast } from "sonner";

import { RepoAvatar } from "@/components/feed/repo-avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { dependencyProjectHref } from "@/lib/dependency-list-filters";
import {
  MAX_PROJECTS_PER_ADD,
  UPDATE_MODE_OPTIONS,
  type AddDependencySource,
  type DepsUpdateModeValue,
} from "@/lib/dependency-settings";
import { depsScanToastId } from "@/lib/toast-ids";
import { cn } from "@/lib/utils";
import { addDependencyProjectsAction, type AddDependencyProjectsResult } from "@/server/actions/dependencies";
import type { AddableSubscription } from "@/server/queries/dependencies";

type Tab = "tracked" | "url";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function getPrModeHint(appConfigured: boolean, single: boolean): string {
  if (!appConfigured) return "Install the GitHub App first: the administrator has not set it up yet.";
  if (!single) return "Pull request modes can be chosen when adding one repository.";
  return "Needs the RepoPulse GitHub App installed on the repository and write access.";
}

function addVisibleUpToLimit(current: string[], visibleIds: string[], limit: number): string[] {
  const next = [...current];
  const seen = new Set(current);
  for (const id of visibleIds) {
    if (next.length >= limit) break;
    if (!seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  return next;
}

function notifyAddProjectsResult({ added, existing, scansQueued }: AddDependencyProjectsResult) {
  if (added.length === 1) {
    const [project] = added;
    if (scansQueued) {
      toast.loading(`Checking the dependencies of ${project!.fullName}…`, {
        id: depsScanToastId(project!.projectId),
        duration: 120_000,
      });
    } else {
      toast.success(`Added ${project!.fullName}`, { description: "Its first check starts shortly." });
    }
  } else if (added.length > 1) {
    toast.success(`Added ${plural(added.length, "project")}`, {
      description: scansQueued ? "Their first checks are running." : "Their first checks start shortly.",
    });
  }
  if (existing.length > 0) {
    toast.info(
      existing.length === 1
        ? `${existing[0]!.fullName} is already a project`
        : `${plural(existing.length, "repository")} already were projects`,
    );
  }
}

function TrackedRepoRow({
  subscription,
  id,
  checked,
  disabled,
  onToggle,
}: {
  subscription: AddableSubscription;
  id: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <li>
      <label htmlFor={id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/50">
        <Checkbox id={id} checked={checked} onCheckedChange={(value) => onToggle(value === true)} disabled={disabled} />
        <RepoAvatar src={subscription.avatarUrl} name={subscription.fullName} className="size-6" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{subscription.fullName}</span>
          {subscription.description ? (
            <span className="block truncate text-xs text-muted-foreground">{subscription.description}</span>
          ) : null}
        </span>
      </label>
    </li>
  );
}

function TrackedReposTabPanel({
  ids,
  subscriptions,
  search,
  onSearchChange,
  selected,
  limit,
  onToggle,
  onToggleAll,
}: {
  ids: string;
  subscriptions: AddableSubscription[];
  search: string;
  onSearchChange: (value: string) => void;
  selected: string[];
  limit: number;
  onToggle: (subscriptionId: string, checked: boolean) => void;
  onToggleAll: (checked: boolean, visibleIds: string[]) => void;
}) {
  const deferredSearch = useDeferredValue(search);
  const words = deferredSearch.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = subscriptions.filter((s) =>
    words.every((w) => s.fullName.toLowerCase().includes(w) || (s.description ?? "").toLowerCase().includes(w)),
  );
  const selectedSet = new Set(selected);
  const visibleIds = filtered.map((s) => s.subscriptionId);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));

  return (
    <div role="tabpanel" id={`${ids}-panel-tracked`} aria-labelledby={`${ids}-tab-tracked`} className="grid gap-2">
      {subscriptions.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          Every repository you track is already a project. Use “By URL” to add another one.
        </p>
      ) : (
        <>
          <div className="relative">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search your tracked repositories"
              aria-label="Search tracked repositories"
              className="pl-8"
              maxLength={200}
            />
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={allVisibleSelected}
                onCheckedChange={(checked) => onToggleAll(checked === true, visibleIds)}
                disabled={filtered.length === 0}
              />
              Select all{words.length > 0 ? " shown" : ""}
            </label>
            <span aria-live="polite">
              {selected.length} selected · at most {limit}
            </span>
          </div>
          <ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-sm text-muted-foreground">No tracked repository matches.</li>
            ) : (
              filtered.map((s) => {
                const checked = selectedSet.has(s.subscriptionId);
                return (
                  <TrackedRepoRow
                    key={s.subscriptionId}
                    subscription={s}
                    id={`${ids}-${s.subscriptionId}`}
                    checked={checked}
                    disabled={!checked && selected.length >= limit}
                    onToggle={(value) => onToggle(s.subscriptionId, value)}
                  />
                );
              })
            )}
          </ul>
        </>
      )}
    </div>
  );
}

function RepoUrlTabPanel({
  ids,
  repo,
  onRepoChange,
}: {
  ids: string;
  repo: string;
  onRepoChange: (value: string) => void;
}) {
  return (
    <div role="tabpanel" id={`${ids}-panel-url`} aria-labelledby={`${ids}-tab-url`} className="grid gap-1.5">
      <Label htmlFor={`${ids}-repo`}>Repository</Label>
      <Input
        id={`${ids}-repo`}
        value={repo}
        onChange={(event) => onRepoChange(event.target.value)}
        placeholder="owner/name or https://github.com/owner/name"
        autoComplete="off"
        maxLength={500}
      />
      <p className="text-xs text-muted-foreground">
        Any repository you can read. Private ones need the RepoPulse GitHub App.
      </p>
    </div>
  );
}

function UpdateModeFieldset({
  ids,
  effectiveMode,
  prModesAvailable,
  prModeHint,
  onSelectMode,
}: {
  ids: string;
  effectiveMode: DepsUpdateModeValue;
  prModesAvailable: boolean;
  prModeHint: string;
  onSelectMode: (mode: DepsUpdateModeValue) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1.5 text-sm font-medium">Updates</legend>
      {UPDATE_MODE_OPTIONS.map((option) => {
        const disabled = option.value !== "NOTIFY" && !prModesAvailable;
        const id = `${ids}-mode-${option.value}`;
        return (
          <div key={option.value} className={cn("flex items-start gap-2.5 text-sm", disabled && "opacity-60")}>
            <input
              id={id}
              type="radio"
              name={`${ids}-mode`}
              value={option.value}
              checked={effectiveMode === option.value}
              disabled={disabled}
              onChange={() => onSelectMode(option.value)}
              className={cn("mt-0.5 accent-primary", disabled && "cursor-not-allowed")}
            />
            <label htmlFor={id} className={cn("grid", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
              <span className="font-medium">{option.label}</span>
              <span className="text-xs text-muted-foreground">
                {option.value === "NOTIFY" ? option.hint : disabled ? prModeHint : option.hint}
              </span>
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

function AddProjectsFailures({ failures }: { failures: AddDependencyProjectsResult["failed"] }) {
  if (failures.length === 0) return null;
  return (
    <div role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm">
      <p className="font-medium text-destructive">Not added:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
        {failures.map((f) => (
          <li key={f.source}>{f.message}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Add projects" (Slice 08 §3.7.2). Two tabs: the user's tracked repositories that are not projects
 * yet (searchable checklist, select all, ≤ 20), and any repository by URL. Pull request modes need the
 * GitHub App and are offered for a single repository; the server checks the installation and the
 * user's write permission.
 */
export function AddDependencyProjectsDialog({
  subscriptions,
  appConfigured,
  remaining,
  children,
}: {
  subscriptions: AddableSubscription[];
  appConfigured: boolean;
  /** Projects the user may still add (50 minus the current count). */
  remaining: number;
  children: ReactNode;
}) {
  const router = useRouter();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>(subscriptions.length > 0 ? "tracked" : "url");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [repo, setRepo] = useState("");
  const [updateMode, setUpdateMode] = useState<DepsUpdateModeValue>("NOTIFY");
  const [notifyNow, setNotifyNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<AddDependencyProjectsResult["failed"]>([]);
  const [pending, startTransition] = useTransition();

  const limit = Math.max(0, Math.min(MAX_PROJECTS_PER_ADD, remaining));
  const sourceCount = tab === "tracked" ? selected.length : repo.trim() ? 1 : 0;
  const single = sourceCount <= 1;
  const prModesAvailable = appConfigured && single;
  const effectiveMode = prModesAvailable ? updateMode : "NOTIFY";

  function reset() {
    setSearch("");
    setSelected([]);
    setRepo("");
    setUpdateMode("NOTIFY");
    setNotifyNow(false);
    setError(null);
    setFailures([]);
  }

  function toggle(subscriptionId: string, checked: boolean) {
    setError(null);
    setSelected((current) => {
      if (!checked) return current.filter((id) => id !== subscriptionId);
      if (current.includes(subscriptionId) || current.length >= limit) return current;
      return [...current, subscriptionId];
    });
  }

  function toggleAll(checked: boolean, visibleIds: string[]) {
    setError(null);
    if (!checked) {
      const visibleSet = new Set(visibleIds);
      setSelected((current) => current.filter((id) => !visibleSet.has(id)));
      return;
    }
    setSelected((current) => addVisibleUpToLimit(current, visibleIds, limit));
  }

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFailures([]);
    const sources: AddDependencySource[] =
      tab === "tracked"
        ? selected.map((subscriptionId) => ({ subscriptionId }))
        : repo.trim()
          ? [{ repoUrlOrSlug: repo.trim() }]
          : [];
    if (sources.length === 0) {
      setError(tab === "tracked" ? "Choose at least one repository." : "Enter a repository.");
      return;
    }
    startTransition(async () => {
      const result = await addDependencyProjectsAction({
        sources,
        updateMode: effectiveMode,
        notifyOnFirstScan: notifyNow,
      });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError(result.error.message);
        toast.error(result.error.message);
        return;
      }
      notifyAddProjectsResult(result.data);
      const { added, existing, failed } = result.data;
      if (failed.length > 0) {
        setFailures(failed);
        setSelected([]);
        return;
      }
      setOpen(false);
      reset();
      if (added.length === 1 && sources.length === 1) router.push(dependencyProjectHref(added[0]!.fullName));
      else if (existing.length === 1 && added.length === 0) router.push(dependencyProjectHref(existing[0]!.fullName));
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Check dependencies</DialogTitle>
          <DialogDescription>
            RepoPulse reads the npm, Bun and Python manifests of these repositories and tells you which dependencies are
            outdated.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div
            role="tablist"
            aria-label="Where to add from"
            className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-sm"
          >
            {(
              [
                ["tracked", "From tracked repositories"],
                ["url", "By URL"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                id={`${ids}-tab-${value}`}
                aria-selected={tab === value}
                aria-controls={`${ids}-panel-${value}`}
                onClick={() => {
                  setTab(value);
                  setError(null);
                }}
                className={cn(
                  "rounded-sm px-3 py-1.5 font-medium transition-colors",
                  tab === value ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <Activity mode={tab === "tracked" ? "visible" : "hidden"}>
            <TrackedReposTabPanel
              ids={ids}
              subscriptions={subscriptions}
              search={search}
              onSearchChange={setSearch}
              selected={selected}
              limit={limit}
              onToggle={toggle}
              onToggleAll={toggleAll}
            />
          </Activity>
          <Activity mode={tab === "url" ? "visible" : "hidden"}>
            <RepoUrlTabPanel
              ids={ids}
              repo={repo}
              onRepoChange={(value) => {
                setRepo(value);
                setError(null);
              }}
            />
          </Activity>

          <UpdateModeFieldset
            ids={ids}
            effectiveMode={effectiveMode}
            prModesAvailable={prModesAvailable}
            prModeHint={getPrModeHint(appConfigured, single)}
            onSelectMode={setUpdateMode}
          />

          <div className="flex items-start gap-2.5 text-sm">
            <Checkbox
              id={`${ids}-notify-now`}
              checked={notifyNow}
              onCheckedChange={(checked) => setNotifyNow(checked === true)}
              className="mt-0.5"
            />
            <label htmlFor={`${ids}-notify-now`} className="grid cursor-pointer">
              Notify about what is outdated now
              <span className="text-xs text-muted-foreground">
                Off: the first check fills the overview quietly, and only later updates are notified.
              </span>
            </label>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AddProjectsFailures failures={failures} />

          <DialogFooter>
            <Button type="submit" disabled={pending || sourceCount === 0 || limit === 0}>
              {pending ? <LoaderCircleIcon className="motion-safe:animate-spin" /> : null}
              {pending ? "Adding…" : sourceCount > 1 ? `Add ${plural(sourceCount, "project")}` : "Add project"}
            </Button>
          </DialogFooter>
          {limit === 0 ? (
            <p className="text-xs text-muted-foreground">
              You have reached the project limit. Remove a project to add another.
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
