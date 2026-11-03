"use client";

import { useId, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, PlusIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { isExpandedCombobox, WatchedPathsPicker } from "@/components/repositories/watched-paths-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  COMMIT_PREFIX_MAX_LENGTH,
  DEPS_NOTIFICATION_LEVEL_OPTIONS,
  formatIgnoreRule,
  GROUP_MODE_OPTIONS,
  MANIFEST_PATH_SUGGESTIONS,
  MAX_IGNORE_RULES,
  MAX_MANIFESTS_PER_PROJECT,
  MAX_OPEN_PRS_MAX,
  MIN_RELEASE_AGE_DAYS_MAX,
  RANGE_STRATEGY_OPTIONS,
  SCAN_INTERVAL_OPTIONS,
  UPDATE_LEVEL_OPTIONS,
  UPDATE_MODE_OPTIONS,
  type DepsGroupModeValue,
  type DepsRangeStrategyValue,
  type DepsUpdateLevelValue,
  type DepsUpdateModeValue,
  type IgnoreRuleValue,
} from "@/lib/dependency-settings";
import type { NotificationLevelValue } from "@/lib/subscription-settings";
import { cn } from "@/lib/utils";
import { ignoreDependencyAction, removeIgnoreRuleAction, updateDependencyProjectSettingsAction } from "@/server/actions/dependencies";

export interface DependencySettingsValues {
  updateMode: DepsUpdateModeValue;
  maxUpdateLevel: DepsUpdateLevelValue;
  includePrereleases: boolean;
  minReleaseAgeDays: number;
  groupMode: DepsGroupModeValue;
  rangeStrategy: DepsRangeStrategyValue;
  maxOpenPrs: number;
  scanIntervalHours: number;
  notificationLevel: NotificationLevelValue;
  manifestPaths: string[];
  commitPrefix: string;
}

function Row({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[14rem_1fr] sm:items-start sm:gap-4">
      <div>
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="grid gap-1.5">{children}</div>
    </div>
  );
}

function OptionSelect<T extends string | number>({
  id,
  value,
  onChange,
  options,
  disabled,
  isDisabled,
}: {
  id: string;
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled?: boolean;
  isDisabled?: (value: T) => boolean;
}) {
  return (
    <Select
      value={String(value)}
      onValueChange={(next) => {
        const option = options.find((o) => String(o.value) === next);
        if (option) onChange(option.value);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="w-full sm:w-72">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={String(option.value)} value={String(option.value)} disabled={isDisabled?.(option.value)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Project settings (§3.7.3): mode, policy, grouping, PR limits, schedule, notifications, manifest
 * paths and commit prefix. Only changed fields are sent. PR modes are disabled with `prModeReason`.
 */
export function DependencySettingsForm({
  projectId,
  fullName,
  values,
  prModeReason,
  detectedManifests,
}: {
  projectId: string;
  fullName: string;
  values: DependencySettingsValues;
  /** Why the PR modes can't be chosen, or `null` (the server re-checks the App and write access). */
  prModeReason: string | null;
  detectedManifests: string[];
}) {
  const router = useRouter();
  const id = useId();
  const [form, setForm] = useState<DependencySettingsValues>(values);
  const [ageText, setAgeText] = useState(String(values.minReleaseAgeDays));
  const [prsText, setPrsText] = useState(String(values.maxOpenPrs));
  const [pathsDraft, setPathsDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Server data changed (saved here or elsewhere): start from it again.
  const [saved, setSaved] = useState(values);
  if (JSON.stringify(saved) !== JSON.stringify(values)) {
    setSaved(values);
    setForm(values);
    setAgeText(String(values.minReleaseAgeDays));
    setPrsText(String(values.maxOpenPrs));
    setPathsDraft("");
  }

  const set = <K extends keyof DependencySettingsValues>(key: K, value: DependencySettingsValues[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const prMode = form.updateMode !== "NOTIFY";
  const suggestions = [...new Set([...detectedManifests, ...MANIFEST_PATH_SUGGESTIONS])].filter((path) => !form.manifestPaths.includes(path)).slice(0, 8);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const minReleaseAgeDays = Number(ageText);
    const maxOpenPrs = Number(prsText);
    if (!Number.isInteger(minReleaseAgeDays) || minReleaseAgeDays < 0 || minReleaseAgeDays > MIN_RELEASE_AGE_DAYS_MAX) {
      setError(`The minimum release age is a whole number of days from 0 to ${MIN_RELEASE_AGE_DAYS_MAX}.`);
      return;
    }
    if (!Number.isInteger(maxOpenPrs) || maxOpenPrs < 1 || maxOpenPrs > MAX_OPEN_PRS_MAX) {
      setError(`Open pull requests: a whole number from 1 to ${MAX_OPEN_PRS_MAX}.`);
      return;
    }
    const manifestPaths = pathsDraft.trim() ? [...form.manifestPaths, pathsDraft.trim()] : form.manifestPaths;
    const next = { ...form, minReleaseAgeDays, maxOpenPrs, manifestPaths };
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(next) as Array<keyof DependencySettingsValues>) {
      const same = key === "manifestPaths" ? samePaths(next.manifestPaths, values.manifestPaths) : next[key] === values[key];
      if (!same) changed[key] = next[key];
    }
    if (Object.keys(changed).length === 0) {
      toast.info("Nothing changed");
      return;
    }
    startTransition(async () => {
      const result = await updateDependencyProjectSettingsAction({ projectId, ...(changed as Partial<DependencySettingsValues>) });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError(result.error.message);
        return;
      }
      setPathsDraft("");
      toast.success(`Settings of ${fullName} saved`, {
        description: result.data.rescanQueued ? "Re-checking the project with the new policy…" : undefined,
      });
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      <Row label="Updates" htmlFor={`${id}-mode`} hint={UPDATE_MODE_OPTIONS.find((o) => o.value === form.updateMode)?.hint}>
        <OptionSelect
          id={`${id}-mode`}
          value={form.updateMode}
          onChange={(value) => set("updateMode", value)}
          options={UPDATE_MODE_OPTIONS}
          disabled={pending}
          isDisabled={(value) => value !== "NOTIFY" && prModeReason !== null && values.updateMode === "NOTIFY"}
        />
        {prModeReason && values.updateMode === "NOTIFY" ? <p className="text-xs text-muted-foreground">Pull request modes: {prModeReason}</p> : null}
      </Row>

      <Row label="Maximum update level" htmlFor={`${id}-level`} hint={UPDATE_LEVEL_OPTIONS.find((o) => o.value === form.maxUpdateLevel)?.hint}>
        <OptionSelect id={`${id}-level`} value={form.maxUpdateLevel} onChange={(value) => set("maxUpdateLevel", value)} options={UPDATE_LEVEL_OPTIONS} disabled={pending} />
      </Row>

      <Row label="Pre-releases" htmlFor={`${id}-pre`} hint="Only when the current version is itself a pre-release of the same line.">
        <div className="flex items-center gap-2">
          <Switch id={`${id}-pre`} checked={form.includePrereleases} onCheckedChange={(checked) => set("includePrereleases", checked)} disabled={pending} />
          <span className="text-sm text-muted-foreground">{form.includePrereleases ? "Included" : "Ignored"}</span>
        </div>
      </Row>

      <Row label="Minimum release age" htmlFor={`${id}-age`} hint="Newer releases are held back, a guard against compromised releases.">
        <div className="flex items-center gap-2">
          <Input
            id={`${id}-age`}
            type="number"
            inputMode="numeric"
            min={0}
            max={MIN_RELEASE_AGE_DAYS_MAX}
            value={ageText}
            onChange={(event) => {
              setAgeText(event.target.value);
              setError(null);
            }}
            className="w-24"
            disabled={pending}
          />
          <span className="text-sm text-muted-foreground">days</span>
        </div>
      </Row>

      <Row label="Range strategy" htmlFor={`${id}-range`} hint={RANGE_STRATEGY_OPTIONS.find((o) => o.value === form.rangeStrategy)?.hint}>
        <OptionSelect id={`${id}-range`} value={form.rangeStrategy} onChange={(value) => set("rangeStrategy", value)} options={RANGE_STRATEGY_OPTIONS} disabled={pending} />
      </Row>

      <Row label="Grouping" htmlFor={`${id}-group`} hint={GROUP_MODE_OPTIONS.find((o) => o.value === form.groupMode)?.hint}>
        <OptionSelect id={`${id}-group`} value={form.groupMode} onChange={(value) => set("groupMode", value)} options={GROUP_MODE_OPTIONS} disabled={pending} />
      </Row>

      <Row label="Open pull requests" htmlFor={`${id}-prs`} hint="At most this many at a time; majors wait last.">
        <Input
          id={`${id}-prs`}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_OPEN_PRS_MAX}
          value={prsText}
          onChange={(event) => {
            setPrsText(event.target.value);
            setError(null);
          }}
          className="w-24"
          disabled={pending || !prMode}
        />
      </Row>

      <Row label="Commit prefix" htmlFor={`${id}-prefix`} hint="Starts every commit message and pull request title.">
        <Input
          id={`${id}-prefix`}
          value={form.commitPrefix}
          onChange={(event) => set("commitPrefix", event.target.value)}
          maxLength={COMMIT_PREFIX_MAX_LENGTH}
          className="w-full font-mono sm:w-72"
          disabled={pending || !prMode}
        />
      </Row>

      <Row label="Check" htmlFor={`${id}-interval`}>
        <OptionSelect
          id={`${id}-interval`}
          value={form.scanIntervalHours}
          onChange={(value) => set("scanIntervalHours", value)}
          options={SCAN_INTERVAL_OPTIONS}
          disabled={pending}
        />
      </Row>

      <Row label="Notifications" htmlFor={`${id}-notify`} hint={DEPS_NOTIFICATION_LEVEL_OPTIONS.find((o) => o.value === form.notificationLevel)?.hint}>
        <OptionSelect
          id={`${id}-notify`}
          value={form.notificationLevel}
          onChange={(value) => set("notificationLevel", value)}
          options={DEPS_NOTIFICATION_LEVEL_OPTIONS}
          disabled={pending}
        />
      </Row>

      <Row
        label="Manifest paths"
        htmlFor={`${id}-paths`}
        hint={`Empty: every package.json, pyproject.toml and requirements file is detected. At most ${MAX_MANIFESTS_PER_PROJECT}.`}
      >
        <div
          onKeyDown={(event) => {
            if (event.key === "Escape" && isExpandedCombobox(event.target)) event.stopPropagation();
          }}
        >
          <WatchedPathsPicker
            id={`${id}-paths`}
            repo={fullName}
            paths={form.manifestPaths}
            onPathsChange={(paths) => set("manifestPaths", paths)}
            draft={pathsDraft}
            onDraftChange={(draft) => {
              setPathsDraft(draft);
              setError(null);
            }}
          />
        </div>
        {suggestions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Add:</span>
            {suggestions.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => set("manifestPaths", [...form.manifestPaths, path])}
                disabled={pending || form.manifestPaths.length >= MAX_MANIFESTS_PER_PROJECT}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono hover:bg-accent"
              >
                <PlusIcon className="size-3" aria-hidden />
                {path}
              </button>
            ))}
          </div>
        ) : null}
      </Row>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? <LoaderCircleIcon className="animate-spin" /> : null}
          {pending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Ignore rules (§3.5 step 2): name patterns with `*` at the start and/or end, optionally limited to a
 * version range. Adding applies at once; removing re-checks the project ("Re-checking…").
 */
export function IgnoreRulesEditor({ projectId, rules }: { projectId: string; rules: IgnoreRuleValue[] }) {
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState("");
  const [versions, setVersions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleError(code: string, message: string) {
    if (code === "UNAUTHORIZED") router.push("/login");
    setError(message);
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Enter a package name or pattern.");
      return;
    }
    startTransition(async () => {
      const result = await ignoreDependencyAction({ projectId, name: name.trim(), versions: versions.trim() || undefined });
      if (!result.ok) return handleError(result.error.code, result.error.message);
      setName("");
      setVersions("");
      toast.success("Ignore rule added", {
        description: result.data.rescanQueued
          ? "Re-checking the project…"
          : result.data.ignored > 0
            ? `${result.data.ignored} dependenc${result.data.ignored === 1 ? "y is" : "ies are"} now ignored.`
            : undefined,
      });
    });
  }

  function remove(rule: IgnoreRuleValue) {
    setError(null);
    startTransition(async () => {
      const result = await removeIgnoreRuleAction({ projectId, name: rule.name, versions: rule.versions });
      if (!result.ok) return handleError(result.error.code, result.error.message);
      toast.success(`Removed “${formatIgnoreRule(rule)}”`, {
        description: result.data.rescanQueued ? "Re-checking…" : "The next check applies it.",
      });
    });
  }

  return (
    <div className="grid gap-3">
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">No ignore rules. Use a row&apos;s menu in the table, or add one here.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {rules.map((rule) => (
            <li key={formatIgnoreRule(rule)} className="inline-flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 font-mono text-xs">
              {rule.name}
              {rule.versions ? <span className="text-muted-foreground">{rule.versions}</span> : null}
              <button
                type="button"
                onClick={() => remove(rule)}
                disabled={pending}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={`Remove ignore rule ${formatIgnoreRule(rule)}`}
              >
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {rules.length < MAX_IGNORE_RULES ? (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-name`} className="text-xs">
              Package or pattern
            </Label>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              placeholder="@types/*"
              className="h-8 w-48 font-mono text-xs"
              maxLength={214}
              disabled={pending}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-versions`} className="text-xs">
              Versions (optional)
            </Label>
            <Input
              id={`${id}-versions`}
              value={versions}
              onChange={(event) => {
                setVersions(event.target.value);
                setError(null);
              }}
              placeholder=">=3"
              className="h-8 w-32 font-mono text-xs"
              maxLength={256}
              disabled={pending}
            />
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
            Add rule
          </Button>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">At most {MAX_IGNORE_RULES} rules.</p>
      )}
      {error ? (
        <p role="alert" className={cn("text-sm text-destructive")}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
