"use client";

import { useId, useMemo, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { RepoAvatar } from "@/components/feed/repo-avatar";
import { depsScanToastId } from "@/components/realtime/sse-listener";
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
import { MAX_PROJECTS_PER_ADD, UPDATE_MODE_OPTIONS, type AddDependencySource, type DepsUpdateModeValue } from "@/lib/dependency-settings";
import { cn } from "@/lib/utils";
import { addDependencyProjectsAction, type AddDependencyProjectsResult } from "@/server/actions/dependencies";
import type { AddableSubscription } from "@/server/queries/dependencies";

type Tab = "tracked" | "url";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
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
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = useMemo(
    () => subscriptions.filter((s) => words.every((w) => s.fullName.toLowerCase().includes(w) || (s.description ?? "").toLowerCase().includes(w))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `words` derives from `search`.
    [subscriptions, search],
  );
  const sourceCount = tab === "tracked" ? selected.length : repo.trim() ? 1 : 0;
  const single = sourceCount <= 1;
  const prModesAvailable = appConfigured && single;
  const prModeHint = !appConfigured
    ? "Install the GitHub App first: the administrator has not set it up yet."
    : !single
      ? "Pull request modes can be chosen when adding one repository."
      : "Needs the RepoPulse GitHub App installed on the repository and write access.";
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

  const visibleIds = filtered.map((s) => s.subscriptionId);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));

  function toggleAll(checked: boolean) {
    setError(null);
    if (!checked) {
      setSelected((current) => current.filter((id) => !visibleIds.includes(id)));
      return;
    }
    setSelected((current) => {
      const next = [...current];
      for (const id of visibleIds) {
        if (next.length >= limit) break;
        if (!next.includes(id)) next.push(id);
      }
      return next;
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFailures([]);
    const sources: AddDependencySource[] =
      tab === "tracked" ? selected.map((subscriptionId) => ({ subscriptionId })) : repo.trim() ? [{ repoUrlOrSlug: repo.trim() }] : [];
    if (sources.length === 0) {
      setError(tab === "tracked" ? "Choose at least one repository." : "Enter a repository.");
      return;
    }
    startTransition(async () => {
      const result = await addDependencyProjectsAction({ sources, updateMode: effectiveMode, notifyOnFirstScan: notifyNow });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError(result.error.message);
        return;
      }
      const { added, existing, failed, scansQueued } = result.data;
      if (added.length === 1) {
        const [project] = added;
        if (scansQueued) toast.loading(`Checking the dependencies of ${project!.fullName}…`, { id: depsScanToastId(project!.projectId), duration: 120_000 });
        else toast.success(`Added ${project!.fullName}`, { description: "Its first check starts shortly." });
      } else if (added.length > 1) {
        toast.success(`Added ${plural(added.length, "project")}`, {
          description: scansQueued ? "Their first checks are running." : "Their first checks start shortly.",
        });
      }
      if (existing.length > 0) {
        toast.info(
          existing.length === 1 ? `${existing[0]!.fullName} is already a project` : `${plural(existing.length, "repository")} already were projects`,
        );
      }
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
            RepoPulse reads the npm, Bun and Python manifests of these repositories and tells you which dependencies are outdated.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div role="tablist" aria-label="Where to add from" className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-sm">
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
                  "rounded px-3 py-1.5 font-medium transition-colors",
                  tab === value ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "tracked" ? (
            <div role="tabpanel" id={`${ids}-panel-tracked`} aria-labelledby={`${ids}-tab-tracked`} className="grid gap-2">
              {subscriptions.length === 0 ? (
                <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  Every repository you track is already a project. Use “By URL” to add another one.
                </p>
              ) : (
                <>
                  <div className="relative">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search your tracked repositories"
                      aria-label="Search tracked repositories"
                      className="pl-8"
                      maxLength={200}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <label className="flex items-center gap-2">
                      <Checkbox checked={allVisibleSelected} onCheckedChange={(checked) => toggleAll(checked === true)} disabled={filtered.length === 0} />
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
                        const checked = selected.includes(s.subscriptionId);
                        const id = `${ids}-${s.subscriptionId}`;
                        return (
                          <li key={s.subscriptionId}>
                            <label htmlFor={id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/50">
                              <Checkbox
                                id={id}
                                checked={checked}
                                onCheckedChange={(value) => toggle(s.subscriptionId, value === true)}
                                disabled={!checked && selected.length >= limit}
                              />
                              <RepoAvatar src={s.avatarUrl} name={s.fullName} className="size-6" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">{s.fullName}</span>
                                {s.description ? <span className="block truncate text-xs text-muted-foreground">{s.description}</span> : null}
                              </span>
                            </label>
                          </li>
                        );
                      })
                    )}
                  </ul>
                </>
              )}
            </div>
          ) : (
            <div role="tabpanel" id={`${ids}-panel-url`} aria-labelledby={`${ids}-tab-url`} className="grid gap-1.5">
              <Label htmlFor={`${ids}-repo`}>Repository</Label>
              <Input
                id={`${ids}-repo`}
                value={repo}
                onChange={(event) => {
                  setRepo(event.target.value);
                  setError(null);
                }}
                placeholder="owner/name or https://github.com/owner/name"
                autoComplete="off"
                maxLength={500}
              />
              <p className="text-xs text-muted-foreground">Any repository you can read. Private ones need the RepoPulse GitHub App.</p>
            </div>
          )}

          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-sm font-medium">Updates</legend>
            {UPDATE_MODE_OPTIONS.map((option) => {
              const disabled = option.value !== "NOTIFY" && !prModesAvailable;
              const id = `${ids}-mode-${option.value}`;
              return (
                <label
                  key={option.value}
                  htmlFor={id}
                  className={cn("flex items-start gap-2.5 text-sm", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}
                >
                  <input
                    id={id}
                    type="radio"
                    name={`${ids}-mode`}
                    value={option.value}
                    checked={effectiveMode === option.value}
                    disabled={disabled}
                    onChange={() => setUpdateMode(option.value)}
                    className="mt-0.5 accent-primary"
                  />
                  <span>
                    <span className="font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">{option.value === "NOTIFY" ? option.hint : disabled ? prModeHint : option.hint}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <label className="flex items-start gap-2.5 text-sm">
            <Checkbox checked={notifyNow} onCheckedChange={(checked) => setNotifyNow(checked === true)} className="mt-0.5" />
            <span>
              Notify about what is outdated now
              <span className="block text-xs text-muted-foreground">
                Off: the first check fills the overview quietly, and only later updates are notified.
              </span>
            </span>
          </label>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {failures.length > 0 ? (
            <div role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm">
              <p className="font-medium text-destructive">Not added:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                {failures.map((f) => (
                  <li key={f.source}>{f.message}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending || sourceCount === 0 || limit === 0}>
              {pending ? <LoaderCircleIcon className="animate-spin" /> : null}
              {pending ? "Adding…" : sourceCount > 1 ? `Add ${plural(sourceCount, "project")}` : "Add project"}
            </Button>
          </DialogFooter>
          {limit === 0 ? <p className="text-xs text-muted-foreground">You have reached the project limit. Remove a project to add another.</p> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
