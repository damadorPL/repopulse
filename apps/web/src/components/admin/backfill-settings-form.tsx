"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, RotateCcwIcon, SaveIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { reapplyBackfillSettingsAction, saveBackfillSettingsAction, type BackfillSettingsInput } from "@/server/actions/backfill-settings";
import type { BackfillSettingView } from "@/server/backfill-settings";

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

export function BackfillSettingsForm({ settings, reapplyCandidates }: { settings: BackfillSettingView[]; reapplyCandidates: number }) {
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

      <section aria-labelledby="reapply-heading" className="space-y-3 rounded-lg border bg-card p-4 sm:p-5">
        <div className="grid gap-1">
          <h3 id="reapply-heading" className="font-medium">
            Apply to existing repositories
          </h3>
          <p className="text-sm text-muted-foreground">
            New settings apply to repositories added from now on. To give repositories already imported the new automatic
            target and age limit, re-run their automatic import.{" "}
            <span className="tabular-nums">
              {reapplyCandidates === 0
                ? "No repository has older releases left to import right now."
                : `${numberFormat.format(reapplyCandidates)} ${reapplyCandidates === 1 ? "repository has" : "repositories have"} older releases on GitHub.`}
            </span>{" "}
            Imported history stays read and sends no notifications.
          </p>
        </div>
        {confirmingReapply ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3 text-sm">
            <span className="mr-auto">
              Re-run the automatic import for {numberFormat.format(reapplyCandidates)}{" "}
              {reapplyCandidates === 1 ? "repository" : "repositories"}? This uses GitHub API quota.
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
            disabled={reapplyCandidates === 0 || dirty || saving}
            title={dirty ? "Save your changes first." : undefined}
          >
            Re-run automatic import…
          </Button>
        )}
      </section>
    </div>
  );
}
