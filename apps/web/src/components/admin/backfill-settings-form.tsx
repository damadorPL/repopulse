"use client";

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, RotateCcwIcon, SaveIcon } from "lucide-react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/feed/relative-time";
import { RepoAvatar } from "@/components/feed/repo-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { reapplyBackfillSettingsAction, saveBackfillSettingsAction, type BackfillSettingsInput } from "@/server/actions/backfill-settings";
import type { BackfillSettingView, ReapplyCandidate } from "@/server/backfill-settings";

type Key = BackfillSettingView["key"];

const COPY: Record<Key, { label: string; unit: string; hint: string }> = {
  defaultTarget: {
    label: "Automatic import",
    unit: "releases",
    hint: "Older releases imported per repository right after it is added. 0 turns the automatic import off.",
  },
  maxAgeDays: {
    label: "Automatic import age limit",
    unit: "days",
    hint: "The automatic import stops at releases older than this. 0 = no age limit. “Load older releases” ignores it.",
  },
  deepStep: {
    label: "“Load older releases” step",
    unit: "releases",
    hint: "How many more releases each click on “Load older releases” imports.",
  },
  deepCooldownMinutes: {
    label: "“Load older releases” cooldown",
    unit: "minutes",
    hint: "Minimum time between two requests for the same repository. 0 = no cooldown.",
  },
  hardCap: {
    label: "Hard cap",
    unit: "releases",
    hint: "Maximum releases stored per repository, “Load older releases” included.",
  },
  minQuota: {
    label: "Minimum GitHub quota",
    unit: "requests",
    hint: "Imports pause while fewer GitHub API requests than this remain, so regular polling never runs out.",
  },
};

const GROUPS: ReadonlyArray<{ title: string; keys: Key[] }> = [
  { title: "When a repository is added", keys: ["defaultTarget", "maxAgeDays"] },
  { title: "“Load older releases”", keys: ["deepStep", "deepCooldownMinutes"] },
  { title: "Limits", keys: ["hardCap", "minQuota"] },
];

const numberFormat = new Intl.NumberFormat("en");

type Draft = Record<Key, string>;

function toDraft(settings: BackfillSettingView[]): Draft {
  return Object.fromEntries(settings.map((s) => [s.key, s.override === null ? "" : String(s.override)])) as Draft;
}

export function BackfillSettingsForm({
  settings,
  candidates = [],
  reapplyCandidates,
}: {
  settings: BackfillSettingView[];
  candidates?: ReapplyCandidate[];
  reapplyCandidates?: number;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(settings);
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings));
  const [error, setError] = useState<string | null>(null);
  const [confirmingReapply, setConfirmingReapply] = useState(false);
  const [saving, startSaving] = useTransition();
  const [reapplying, startReapplying] = useTransition();

  const byKey = new Map(saved.map((s) => [s.key, s]));
  const savedDraft = toDraft(saved);
  const dirty = (Object.keys(draft) as Key[]).some((key) => draft[key].trim() !== savedDraft[key]);

  const candidateCount = candidates.length > 0 ? candidates.length : (reapplyCandidates ?? 0);
  const rawTarget = draft.defaultTarget.trim();
  const effectiveTarget = rawTarget !== "" && Number.isInteger(Number(rawTarget)) && Number(rawTarget) >= 0
    ? Number(rawTarget)
    : (byKey.get("defaultTarget")?.value ?? 100);
  const totalMissing = candidates.reduce((sum, c) => sum + Math.max(0, effectiveTarget - c.releaseCount), 0);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const input = {} as Record<Key, number | null>;
    for (const key of Object.keys(draft) as Key[]) {
      const raw = draft[key].trim();
      if (raw === "") {
        input[key] = null;
        continue;
      }
      const value = Number(raw);
      const { min, max } = byKey.get(key)!;
      if (!Number.isInteger(value) || value < min || value > max) {
        setError(`${COPY[key].label}: enter a whole number from ${numberFormat.format(min)} to ${numberFormat.format(max)}, or leave it empty.`);
        return;
      }
      input[key] = value;
    }
    startSaving(async () => {
      const result = await saveBackfillSettingsAction(input satisfies BackfillSettingsInput);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSaved(result.data);
      setDraft(toDraft(result.data));
      toast.success("Release history settings saved", { description: "They apply to the next import, without a restart." });
      router.refresh();
    });
  }

  function reapply() {
    startReapplying(async () => {
      const result = await reapplyBackfillSettingsAction();
      setConfirmingReapply(false);
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      const { queued } = result.data;
      toast.success(
        queued === 0 ? "Every repository is up to date" : `Importing more history for ${queued} ${queued === 1 ? "repository" : "repositories"}`,
        queued === 0 ? undefined : { description: "Imports run in the background and pause when the GitHub quota runs low." },
      );
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="space-y-5 rounded-lg border bg-card p-4 sm:p-5" noValidate>
        {GROUPS.map((group) => (
          <fieldset key={group.title} className="grid gap-4">
            <legend className="mb-3 text-sm font-medium">{group.title}</legend>
            {group.keys.map((key) => {
              const setting = byKey.get(key)!;
              const copy = COPY[key];
              const id = `backfill-${key}`;
              const fallbackLabel =
                setting.fallbackSource === "env" ? `${setting.envVar} = ${numberFormat.format(setting.fallback)}` : `default ${numberFormat.format(setting.fallback)}`;
              return (
                <div key={key} className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-start sm:gap-4">
                  <div className="grid gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Label htmlFor={id}>{copy.label}</Label>
                      {setting.source === "admin" ? (
                        <Badge variant="secondary" className="text-[10px]">
                          Custom
                        </Badge>
                      ) : null}
                    </div>
                    <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                      {copy.hint}
                    </p>
                  </div>
                  <div className="grid gap-1">
                    <div className="flex items-center gap-1.5">
                      <div className="relative flex-1">
                        <Input
                          id={id}
                          type="number"
                          inputMode="numeric"
                          min={setting.min}
                          max={setting.max}
                          step={1}
                          value={draft[key]}
                          placeholder={String(setting.fallback)}
                          onChange={(event) => {
                            setDraft((current) => ({ ...current, [key]: event.target.value }));
                            setError(null);
                          }}
                          aria-describedby={`${id}-hint ${id}-fallback`}
                          className="pr-[4.75rem] tabular-nums"
                        />
                        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                          {copy.unit}
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className={cn(draft[key] === "" && "invisible")}
                        onClick={() => setDraft((current) => ({ ...current, [key]: "" }))}
                        aria-label={`Reset ${copy.label} to ${fallbackLabel}`}
                        title={`Reset to ${fallbackLabel}`}
                      >
                        <RotateCcwIcon />
                      </Button>
                    </div>
                    <p id={`${id}-fallback`} className="text-[11px] text-muted-foreground">
                      Empty = {fallbackLabel}
                    </p>
                  </div>
                </div>
              );
            })}
          </fieldset>
        ))}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          {dirty ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(savedDraft)} disabled={saving}>
              Discard changes
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={saving || !dirty}>
            {saving ? <LoaderCircleIcon className="animate-spin" /> : <SaveIcon />}
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>

      <section aria-labelledby="reapply-heading" className="space-y-4 rounded-lg border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="grid gap-1">
            <h3 id="reapply-heading" className="font-medium">
              Apply to existing repositories
            </h3>
            <p className="text-sm text-muted-foreground">
              New settings apply to repositories added from now on. To give repositories already imported the new automatic
              target and age limit, re-run their automatic import.{" "}
              <span className="tabular-nums">
                {candidateCount === 0
                  ? "No repository has older releases left to import right now."
                  : `${numberFormat.format(candidateCount)} ${candidateCount === 1 ? "repository has" : "repositories have"} older releases on GitHub.`}
              </span>{" "}
              {candidates.length > 0 && totalMissing > 0 ? (
                <span className="tabular-nums">
                  Across these repositories, approximately {numberFormat.format(totalMissing)} releases are missing to reach the target of {numberFormat.format(effectiveTarget)}.
                </span>
              ) : null}
              {" "}Imported history stays read and sends no notifications.
            </p>
          </div>
          {candidates.length > 0 ? (
            <Badge variant="outline" className="tabular-nums font-mono text-xs">
              {candidateCount} {candidateCount === 1 ? "repo" : "repos"} · {numberFormat.format(totalMissing)} missing
            </Badge>
          ) : null}
        </div>

        {candidates.length > 0 ? (
          <div className="rounded-md border bg-muted/20">
            <div className="flex items-center justify-between border-b px-3.5 py-2 text-xs font-medium text-muted-foreground">
              <span>Repository</span>
              <div className="flex items-center gap-6">
                <span className="hidden sm:inline">Stored</span>
                <span>Missing releases</span>
              </div>
            </div>
            <ul className="divide-y max-h-72 overflow-y-auto">
              {candidates.map((repo) => {
                const missing = Math.max(0, effectiveTarget - repo.releaseCount);
                return (
                  <li key={repo.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5 hover:bg-muted/30">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <RepoAvatar src={repo.avatarUrl} name={repo.fullName.split("/")[1] ?? repo.fullName} className="size-6 text-[10px]" />
                      <div className="min-w-0">
                        <Link href={`/repositories/${repo.fullName}`} className="truncate font-medium text-sm hover:underline block">
                          {repo.fullName}
                        </Link>
                        {repo.oldestRelease ? (
                          <p className="text-[11px] text-muted-foreground truncate">
                            oldest: <span className="font-mono text-foreground/80">{repo.oldestRelease.tagName}</span>
                            {" · "}<RelativeTime date={repo.oldestRelease.publishedAt} />
                          </p>
                        ) : (
                          <p className="text-[11px] text-muted-foreground italic">no releases stored yet</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                      <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">
                        {numberFormat.format(repo.releaseCount)} stored
                      </span>
                      {missing > 0 ? (
                        <Badge variant="outline" className="font-mono text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 border-amber-500/20 tabular-nums">
                          +{numberFormat.format(missing)} missing
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="font-mono text-xs tabular-nums" title={`Has reached target of ${effectiveTarget} releases; more older releases exist on GitHub`}>
                          At target ({numberFormat.format(effectiveTarget)})
                        </Badge>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            No repository has older releases left to import right now.
          </div>
        )}

        {confirmingReapply ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3 text-sm">
            <span className="mr-auto">
              Re-run the automatic import for {numberFormat.format(candidateCount)}{" "}
              {candidateCount === 1 ? "repository" : "repositories"}
              {totalMissing > 0 ? ` (~${numberFormat.format(totalMissing)} releases missing)` : ""}? This uses GitHub API quota.
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingReapply(false)} disabled={reapplying}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={reapply} disabled={reapplying}>
              {reapplying ? <LoaderCircleIcon className="animate-spin" /> : null}
              {reapplying ? "Queuing…" : "Re-run import"}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConfirmingReapply(true)}
            disabled={candidateCount === 0 || dirty || saving}
            title={dirty ? "Save your changes first." : undefined}
          >
            Re-run automatic import…
          </Button>
        )}
      </section>
    </div>
  );
}
