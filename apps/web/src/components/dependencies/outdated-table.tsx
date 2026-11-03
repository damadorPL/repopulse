"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BanIcon, EllipsisIcon, ExternalLinkIcon, FileTextIcon, RssIcon } from "lucide-react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/feed/relative-time";
import { SemverBadge } from "@/components/feed/semver-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { filterUpdateRows, type UpdateTableFilters } from "@/lib/dependency-list-filters";
import {
  changelogUrl,
  DEPENDENCY_KINDS,
  DEPENDENCY_UPDATE_STATUSES,
  githubRepoFromUrl,
  KIND_LABELS,
  registryUrl,
  STATUS_META,
  statusExplanation,
  type DependencyUpdateStatusValue,
} from "@/lib/dependency-settings";
import type { SemverTypeValue } from "@/lib/feed-filters";
import { cn } from "@/lib/utils";
import { ignoreDependencyAction } from "@/server/actions/dependencies";
import { addRepositoryAction } from "@/server/actions/repositories";
import type { DependencyManifestView, DependencyUpdateView } from "@/server/queries/dependencies";

const ALL = "__all__";

const STATUS_RANK: Record<DependencyUpdateStatusValue, number> = {
  OUTDATED: 0,
  TOO_NEW: 1,
  BLOCKED_BY_RANGE: 2,
  ABOVE_LEVEL: 3,
  DISMISSED: 4,
  IGNORED: 5,
  UNSUPPORTED_SOURCE: 6,
};

const STATUS_TONE: Record<DependencyUpdateStatusValue, string> = {
  OUTDATED: "text-foreground font-medium",
  TOO_NEW: "text-amber-700 dark:text-amber-400",
  BLOCKED_BY_RANGE: "text-amber-700 dark:text-amber-400",
  ABOVE_LEVEL: "text-muted-foreground",
  DISMISSED: "text-muted-foreground",
  IGNORED: "text-muted-foreground",
  UNSUPPORTED_SOURCE: "text-muted-foreground",
};

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? undefined : next)}>
      <SelectTrigger className="h-8 w-auto min-w-32 text-xs" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {label.toLowerCase()}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Version({ value, className }: { value: string | null; className?: string }) {
  return value ? <code className={cn("font-mono text-xs", className)}>{value}</code> : <span className="text-muted-foreground">—</span>;
}

/** Row actions: ignore this version / the dependency, changelog, and "Track releases" (the bridge back to the feed). */
function RowActions({
  projectId,
  row,
  tracked,
}: {
  projectId: string;
  row: DependencyUpdateView;
  /** The dependency's source repository is already tracked (or unknown). */
  tracked: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const version = row.targetVersion ?? row.latestVersion;
  const changelog = changelogUrl(row.sourceRepoUrl);
  const source = githubRepoFromUrl(row.sourceRepoUrl);

  function handle(code: string, message: string) {
    if (code === "UNAUTHORIZED") router.push("/login");
    toast.error(message);
  }

  function ignore(versions?: string) {
    startTransition(async () => {
      const result = await ignoreDependencyAction({ projectId, name: row.name, versions });
      if (!result.ok) return handle(result.error.code, result.error.message);
      setOpen(false);
      toast.success(versions ? `Ignoring ${row.name} ${versions}` : `Ignoring ${row.name}`, {
        description: result.data.rescanQueued ? "Re-checking the project for other versions…" : "Remove the rule in Settings to undo.",
      });
    });
  }

  function track() {
    if (!source) return;
    startTransition(async () => {
      const result = await addRepositoryAction({ repoUrlOrSlug: source.fullName, includePrereleases: false, tagIds: [] });
      if (!result.ok) return handle(result.error.code, result.error.message);
      setOpen(false);
      toast.success(`Tracking the releases of ${result.data.fullName}`);
      router.refresh();
    });
  }

  const canIgnore = row.status !== "IGNORED" && row.status !== "UNSUPPORTED_SOURCE";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.name}`} disabled={pending}>
          <EllipsisIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-1">
        <div className="grid text-sm">
          {canIgnore && version ? (
            <button
              type="button"
              className="flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
              onClick={() => ignore(row.ecosystem === "PYPI" ? `==${version}` : version)}
              disabled={pending}
            >
              <BanIcon className="size-4 text-muted-foreground" aria-hidden />
              Ignore {version}
            </button>
          ) : null}
          {canIgnore ? (
            <button
              type="button"
              className="flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
              onClick={() => ignore()}
              disabled={pending}
            >
              <BanIcon className="size-4 text-muted-foreground" aria-hidden />
              Ignore {row.name}
            </button>
          ) : null}
          {changelog ? (
            <a href={changelog} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
              <FileTextIcon className="size-4 text-muted-foreground" aria-hidden />
              Changelog
              <ExternalLinkIcon className="ml-auto size-3.5 text-muted-foreground" aria-hidden />
            </a>
          ) : null}
          <a
            href={registryUrl(row.ecosystem, row.name)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
          >
            <ExternalLinkIcon className="size-4 text-muted-foreground" aria-hidden />
            {row.ecosystem === "NPM" ? "npm" : "PyPI"} page
          </a>
          {source && !tracked ? (
            <button type="button" className="flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent" onClick={track} disabled={pending}>
              <RssIcon className="size-4 text-muted-foreground" aria-hidden />
              Track releases of {source.fullName}
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The outdated table of a project (§3.7.3), grouped by manifest, with level / kind / ecosystem /
 * status filters (client state) and row actions.
 */
export function OutdatedTable({
  projectId,
  rows,
  manifests,
  minReleaseAgeDays,
  trackedFullNames,
}: {
  projectId: string;
  rows: DependencyUpdateView[];
  manifests: DependencyManifestView[];
  minReleaseAgeDays: number;
  trackedFullNames: string[];
}) {
  const [filters, setFilters] = useState<UpdateTableFilters>({});
  const tracked = useMemo(() => new Set(trackedFullNames), [trackedFullNames]);
  const ecosystems = [...new Set(manifests.map((m) => m.ecosystem))];
  const shown = filterUpdateRows(rows, filters);
  const byManifest = manifests
    .map((manifest) => ({
      manifest,
      rows: shown
        .filter((row) => row.manifestId === manifest.id)
        .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name)),
    }))
    .filter((group) => group.rows.length > 0);

  const set = (patch: Partial<UpdateTableFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const active = Boolean(filters.level || filters.kind || filters.ecosystem || filters.status || filters.q);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={filters.q ?? ""}
          onChange={(event) => set({ q: event.target.value || undefined })}
          placeholder="Filter by name"
          aria-label="Filter dependencies by name"
          className="h-8 w-44 text-xs"
          maxLength={100}
        />
        <FilterSelect
          label="Levels"
          value={filters.level}
          onChange={(level) => set({ level: level as UpdateTableFilters["level"] })}
          options={[
            { value: "MAJOR", label: "Major" },
            { value: "MINOR", label: "Minor" },
            { value: "PATCH", label: "Patch" },
            { value: "OTHER", label: "Other" },
          ]}
        />
        <FilterSelect
          label="Kinds"
          value={filters.kind}
          onChange={(kind) => set({ kind: kind as UpdateTableFilters["kind"] })}
          options={DEPENDENCY_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] }))}
        />
        {ecosystems.length > 1 ? (
          <FilterSelect
            label="Ecosystems"
            value={filters.ecosystem}
            onChange={(ecosystem) => set({ ecosystem: ecosystem as UpdateTableFilters["ecosystem"] })}
            options={[
              { value: "NPM", label: "npm" },
              { value: "PYPI", label: "PyPI" },
            ]}
          />
        ) : null}
        <FilterSelect
          label="Statuses"
          value={filters.status}
          onChange={(status) => set({ status: status as UpdateTableFilters["status"] })}
          options={DEPENDENCY_UPDATE_STATUSES.map((status) => ({ value: status, label: STATUS_META[status].label }))}
        />
        {active ? (
          <Button variant="ghost" size="sm" onClick={() => setFilters({})}>
            Clear
          </Button>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
          {shown.length} of {rows.length}
        </span>
      </div>

      {byManifest.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          {rows.length === 0 ? "Every dependency is up to date." : "No dependency matches these filters."}
        </p>
      ) : (
        byManifest.map(({ manifest, rows: manifestRows }) => (
          <div key={manifest.id} className="overflow-x-auto rounded-md border">
            <p className="border-b bg-muted/40 px-3 py-2 font-mono text-xs">{manifest.path}</p>
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 font-medium">Kind</th>
                  <th className="px-2 py-2 font-medium">Declared</th>
                  <th className="px-2 py-2 font-medium">Current</th>
                  <th className="px-2 py-2 font-medium">Wanted</th>
                  <th className="px-2 py-2 font-medium">Target</th>
                  <th className="px-2 py-2 font-medium">Latest</th>
                  <th className="px-2 py-2 font-medium">Level</th>
                  <th className="px-2 py-2 font-medium">Released</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  <th className="px-2 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {manifestRows.map((row) => {
                  const explanation = statusExplanation(row, minReleaseAgeDays);
                  const source = githubRepoFromUrl(row.sourceRepoUrl);
                  return (
                    <tr key={row.id} className="align-top">
                      <td className="px-3 py-2">
                        <a
                          href={registryUrl(row.ecosystem, row.name)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs font-medium hover:underline"
                        >
                          {row.name}
                        </a>
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {KIND_LABELS[row.kind]}
                        {row.group ? <span className="block font-mono">{row.group}</span> : null}
                      </td>
                      <td className="px-2 py-2">
                        <Version value={row.declared || null} className="text-muted-foreground" />
                      </td>
                      <td className="px-2 py-2">
                        <Version value={row.currentVersion} />
                      </td>
                      <td className="px-2 py-2">
                        <Version value={row.wantedVersion} />
                      </td>
                      <td className="px-2 py-2">
                        <Version value={row.targetVersion} className="font-semibold" />
                      </td>
                      <td className="px-2 py-2">
                        <Version value={row.latestVersion} />
                      </td>
                      <td className="px-2 py-2">{row.level ? <SemverBadge type={row.level as SemverTypeValue} /> : null}</td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {row.targetReleasedAt ? <RelativeTime date={row.targetReleasedAt} /> : "—"}
                      </td>
                      <td className="max-w-56 px-2 py-2 text-xs">
                        <span className={STATUS_TONE[row.status]} title={STATUS_META[row.status].hint}>
                          {STATUS_META[row.status].label}
                        </span>
                        {explanation ? <span className="block text-muted-foreground">{explanation}</span> : null}
                      </td>
                      <td className="px-2 py-1 text-right">
                        <RowActions projectId={projectId} row={row} tracked={!source || tracked.has(source.fullName.toLowerCase())} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  );
}
