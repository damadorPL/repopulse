"use client";

import { useId, useOptimistic, useState, useTransition, type FormEvent } from "react";
import { FolderIcon, FolderPlusIcon, PencilIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isTrackMode, PATHS_OPTION, TRACK_MODE_OPTIONS, type TrackModeValue } from "@/lib/track-modes";
import { summarizeWatchedPaths, validateWatchedPaths } from "@/lib/watched-paths";
import { updateTrackModeAction } from "@/server/actions/repositories";
import { isExpandedCombobox, WatchedPathsPicker } from "./watched-paths-picker";

interface Tracking {
  trackMode: TrackModeValue;
  trackPaths: boolean;
}

/**
 * What a repository card tracks: a release mode select ("Releases", "Releases + tags" or "No
 * releases") and, independently, "Files / folders" with a popover to edit the watched paths. Both
 * can be on at once. Turning "Files / folders" on, or choosing "No releases" while it is off, opens
 * the paths editor first: the change is saved with the paths, since something must stay tracked.
 */
export function TrackModeToggle({
  subscriptionId,
  fullName,
  trackMode,
  trackPaths,
  watchedPaths,
}: {
  subscriptionId: string;
  fullName: string;
  trackMode: TrackModeValue;
  trackPaths: boolean;
  watchedPaths: string[];
}) {
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic<Tracking>({ trackMode, trackPaths });
  const [editorOpen, setEditorOpen] = useState(false);
  /** Release mode to save along with the paths (a "No releases" choice waiting for paths). */
  const [modeAfterPaths, setModeAfterPaths] = useState<TrackModeValue | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [pathsDraft, setPathsDraft] = useState("");
  const [pathsError, setPathsError] = useState<string | null>(null);
  const inputId = useId();

  function save(next: Tracking, nextPaths?: string[], onDone?: () => void) {
    startTransition(async () => {
      setOptimistic(next);
      const result = await updateTrackModeAction({
        subscriptionId,
        ...next,
        ...(nextPaths ? { watchedPaths: nextPaths } : {}),
      });
      if (!result.ok) {
        if (nextPaths) setPathsError(result.error.message);
        else toast.error(result.error.message);
        return;
      }
      onDone?.();
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

  function openEditor(mode: TrackModeValue | null = null) {
    setModeAfterPaths(mode);
    setPaths(watchedPaths);
    setPathsDraft("");
    setPathsError(null);
    setEditorOpen(true);
  }

  function changeMode(value: string) {
    if (!isTrackMode(value) || value === optimistic.trackMode) return;
    // "No releases" alone would track nothing: ask for paths first.
    if (value === "NONE" && !optimistic.trackPaths) {
      // After the select has closed and returned focus to its trigger, or the popover would
      // treat that focus move as an outside interaction and close again.
      setTimeout(() => openEditor("NONE"), 0);
      return;
    }
    save({ ...optimistic, trackMode: value });
  }

  function submitPaths(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Include text typed but not yet added as a chip.
    const validation = validateWatchedPaths([...paths, pathsDraft]);
    if (!validation.ok) {
      setPathsError(validation.message);
      return;
    }
    save({ trackMode: modeAfterPaths ?? optimistic.trackMode, trackPaths: true }, validation.paths, () => setEditorOpen(false));
  }

  function stopWatching() {
    save({ ...optimistic, trackPaths: false }, undefined, () => setEditorOpen(false));
  }

  const canStopWatching = optimistic.trackPaths && optimistic.trackMode !== "NONE";

  return (
    <div className="flex items-center gap-1.5">
      <dt className="sr-only">Tracking</dt>
      <dd className="flex flex-wrap items-center gap-1.5">
        <Select value={optimistic.trackMode} onValueChange={changeMode} disabled={pending}>
          <SelectTrigger className="h-6 gap-1 px-2 text-xs" aria-label={`Release tracking of ${fullName}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRACK_MODE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-xs">
                {option.short}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Popover
          open={editorOpen}
          onOpenChange={(next) => {
            if (pending) return;
            if (next) openEditor();
            else setEditorOpen(false);
          }}
        >
          <PopoverTrigger asChild>
            {optimistic.trackPaths ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 max-w-56 gap-1 px-1.5 text-xs font-normal text-muted-foreground"
                title={watchedPaths.length > 0 ? `Watching ${watchedPaths.join(", ")}` : undefined}
                aria-label={`Edit the watched files and folders of ${fullName}`}
              >
                <FolderIcon className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate font-mono">{watchedPaths.length > 0 ? summarizeWatchedPaths(watchedPaths) : "Choose paths"}</span>
                <PencilIcon className="size-3 shrink-0 opacity-60" aria-hidden />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-xs font-normal text-muted-foreground"
                disabled={pending}
                title={PATHS_OPTION.hint}
                aria-label={`Also track files and folders of ${fullName}`}
              >
                <FolderPlusIcon className="size-3.5 shrink-0" aria-hidden />
                {PATHS_OPTION.label}
              </Button>
            )}
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[28rem] max-w-[calc(100vw-2rem)] p-3"
            onEscapeKeyDown={(event) => isExpandedCombobox(event.target) && event.preventDefault()}
          >
            <form onSubmit={submitPaths} className="grid gap-2">
              <Label htmlFor={inputId} className="text-xs font-medium">
                Watched files and folders
              </Label>
              <WatchedPathsPicker
                id={inputId}
                repo={fullName}
                paths={paths}
                onPathsChange={(next) => {
                  setPaths(next);
                  setPathsError(null);
                }}
                draft={pathsDraft}
                onDraftChange={(next) => {
                  setPathsDraft(next);
                  setPathsError(null);
                }}
                error={pathsError}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                {modeAfterPaths === "NONE"
                  ? "Releases stop showing for this repository; only commits that change these paths do."
                  : optimistic.trackMode === "NONE"
                    ? "Commits that change these paths show up in the feed. To stop watching them, choose a release mode first."
                    : "Commits that change these paths show up in the feed alongside releases."}
              </p>
              <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
                {/* Not in "No releases": something must stay tracked. */}
                {canStopWatching && modeAfterPaths === null ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mr-auto text-muted-foreground"
                    onClick={stopWatching}
                    disabled={pending}
                  >
                    Stop watching paths
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditorOpen(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={pending || (paths.length === 0 && !pathsDraft.trim())}>
                  {pending ? "Saving…" : "Save"}
                </Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
      </dd>
    </div>
  );
}
