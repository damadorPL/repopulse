"use client";

import { useId, useOptimistic, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { isTrackMode, PATHS_OPTION, TRACK_MODE_OPTIONS, type TrackModeValue } from "@/lib/track-modes";
import { validateWatchedPaths } from "@/lib/watched-paths";
import { updateSubscriptionSettingsAction, updateTrackModeAction } from "@/server/actions/repositories";
import { WatchedPathsPicker } from "./watched-paths-picker";

interface Tracking {
  trackMode: TrackModeValue;
  trackPaths: boolean;
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, i) => path === b[i]);
}

/**
 * The Tracking section of the repository settings page (Slice 07): release mode, "Files / folders"
 * with the watched paths editor inline, and "Include pre-releases". Saves through the same actions
 * as the old card controls (`updateTrackModeAction`; pre-releases through
 * `updateSubscriptionSettingsAction`). Something must stay tracked: choosing "No releases" without
 * watched paths, or turning "Files / folders" on, saves together with the paths.
 */
export function TrackingSettings({
  subscriptionId,
  fullName,
  trackMode,
  trackPaths,
  watchedPaths,
  includePrereleases,
}: {
  subscriptionId: string;
  fullName: string;
  trackMode: TrackModeValue;
  trackPaths: boolean;
  watchedPaths: string[];
  includePrereleases: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic<Tracking>({ trackMode, trackPaths });
  const [prereleases, setPrereleases] = useOptimistic(includePrereleases);
  /** The paths editor is open for turning "Files / folders" on (with an optional release mode to save along). */
  const [enabling, setEnabling] = useState<{ mode: TrackModeValue | null } | null>(null);
  const [paths, setPaths] = useState<string[]>(watchedPaths);
  const [draft, setDraft] = useState("");
  const [pathsError, setPathsError] = useState<string | null>(null);
  const modeId = useId();
  const pathsId = useId();
  const pathsSwitchId = useId();
  const prereleaseId = useId();

  // Server data changed (saved here or elsewhere): start the editor from it again.
  const [savedPaths, setSavedPaths] = useState(watchedPaths);
  if (!samePaths(savedPaths, watchedPaths)) {
    setSavedPaths(watchedPaths);
    setPaths(watchedPaths);
    setDraft("");
  }

  const editorOpen = optimistic.trackPaths || enabling !== null;

  function handleError(code: string, message: string, inline: boolean) {
    if (code === "UNAUTHORIZED") router.push("/login");
    if (inline) setPathsError(message);
    else toast.error(message);
  }

  function save(next: Tracking, nextPaths?: string[], onDone?: () => void) {
    startTransition(async () => {
      setOptimistic(next);
      const result = await updateTrackModeAction({ subscriptionId, ...next, ...(nextPaths ? { watchedPaths: nextPaths } : {}) });
      if (!result.ok) {
        handleError(result.error.code, result.error.message, Boolean(nextPaths));
        return;
      }
      onDone?.();
      toast.success(`Tracking of ${fullName} updated`);
      if (result.data.importingPaths) {
        toast.info(`Importing commits of ${fullName}…`, {
          description: "Recent commits that change the watched paths appear in the feed in a moment.",
        });
      }
      if (result.data.importingTags) {
        toast.info(`Importing the Git tags of ${fullName}…`, {
          description: "Tags without a GitHub release appear in the feed in a moment.",
        });
      }
    });
  }

  function changeMode(value: string) {
    if (!isTrackMode(value) || value === optimistic.trackMode) return;
    // "No releases" alone would track nothing: ask for paths first.
    if (value === "NONE" && !optimistic.trackPaths) {
      setEnabling({ mode: "NONE" });
      setPathsError(null);
      return;
    }
    save({ ...optimistic, trackMode: value });
  }

  function togglePaths(checked: boolean) {
    setPathsError(null);
    if (checked) {
      setEnabling({ mode: null });
      setPaths(watchedPaths);
      setDraft("");
      return;
    }
    if (enabling) {
      setEnabling(null);
      return;
    }
    save({ ...optimistic, trackPaths: false });
  }

  function submitPaths(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Include text typed but not yet added as a chip.
    const validation = validateWatchedPaths([...paths, draft]);
    if (!validation.ok) {
      setPathsError(validation.message);
      return;
    }
    save({ trackMode: enabling?.mode ?? optimistic.trackMode, trackPaths: true }, validation.paths, () => setEnabling(null));
  }

  function togglePrereleases(checked: boolean) {
    startTransition(async () => {
      setPrereleases(checked);
      const result = await updateSubscriptionSettingsAction({ subscriptionId, includePrereleases: checked });
      if (!result.ok) {
        handleError(result.error.code, result.error.message, false);
        return;
      }
      toast.success(checked ? `Pre-releases of ${fullName} now show in your feed` : `Pre-releases of ${fullName} are hidden`);
    });
  }

  const pathsLocked = optimistic.trackPaths && optimistic.trackMode === "NONE";
  const dirty = enabling !== null || !samePaths(paths, watchedPaths) || draft.trim() !== "";
  const modeOption = TRACK_MODE_OPTIONS.find((option) => option.value === optimistic.trackMode);

  return (
    <div className="grid gap-5">
      <div className="grid gap-1.5 sm:grid-cols-[14rem_1fr] sm:items-start sm:gap-4">
        <div>
          <Label htmlFor={modeId}>Releases</Label>
          <p className="mt-1 text-xs text-muted-foreground">What the feed shows of this repository&apos;s releases.</p>
        </div>
        <div className="grid gap-1.5">
          <Select value={enabling?.mode ?? optimistic.trackMode} onValueChange={changeMode} disabled={pending}>
            <SelectTrigger id={modeId} className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRACK_MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {enabling?.mode === "NONE" ? "Add watched paths below to save “No releases”." : modeOption?.hint}
          </p>
        </div>
      </div>

      <div className="grid gap-1.5 sm:grid-cols-[14rem_1fr] sm:items-start sm:gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Switch
              id={pathsSwitchId}
              checked={editorOpen}
              onCheckedChange={togglePaths}
              disabled={pending || pathsLocked}
            />
            <Label htmlFor={pathsSwitchId}>{PATHS_OPTION.label}</Label>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {pathsLocked ? "Choose a release mode first to stop watching paths." : PATHS_OPTION.hint}
          </p>
        </div>
        {editorOpen ? (
          <form onSubmit={submitPaths} className="grid gap-2">
            <Label htmlFor={pathsId} className="sr-only">
              Watched files and folders
            </Label>
            <WatchedPathsPicker
              id={pathsId}
              repo={fullName}
              paths={paths}
              onPathsChange={(next) => {
                setPaths(next);
                setPathsError(null);
              }}
              draft={draft}
              onDraftChange={(next) => {
                setDraft(next);
                setPathsError(null);
              }}
              error={pathsError}
              describedBy={`${pathsId}-help`}
            />
            <p id={`${pathsId}-help`} className="text-xs text-muted-foreground">
              Commits on the default branch that change these paths show up in the feed. A folder matches every file inside it.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={pending || !dirty || (paths.length === 0 && !draft.trim())}>
                {pending ? "Saving…" : enabling ? "Save and watch" : "Save paths"}
              </Button>
              {dirty ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setEnabling(null);
                    setPaths(watchedPaths);
                    setDraft("");
                    setPathsError(null);
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">Off</p>
        )}
      </div>

      {optimistic.trackMode !== "NONE" ? (
        <div className="grid gap-1.5 sm:grid-cols-[14rem_1fr] sm:items-start sm:gap-4">
          <div className="flex items-center gap-2">
            <Switch id={prereleaseId} checked={prereleases} onCheckedChange={togglePrereleases} disabled={pending} />
            <Label htmlFor={prereleaseId}>Include pre-releases</Label>
          </div>
          <p className="text-xs text-muted-foreground sm:pt-0.5">
            Alpha, beta and release candidates. Turning this on marks the stored pre-releases among the 10 newest updates as
            unread; turning it off removes unread pre-releases from your feed.
          </p>
        </div>
      ) : null}
    </div>
  );
}
