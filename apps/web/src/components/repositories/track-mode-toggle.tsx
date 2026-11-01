"use client";

import { useId, useOptimistic, useState, useTransition, type FormEvent } from "react";
import { FolderIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isTrackMode, TRACK_MODE_OPTIONS, type TrackModeValue } from "@/lib/track-modes";
import {
  formatWatchedPaths,
  MAX_WATCHED_PATHS,
  summarizeWatchedPaths,
  validateWatchedPaths,
  WATCHED_PATHS_PLACEHOLDER,
} from "@/lib/watched-paths";
import { updateTrackModeAction } from "@/server/actions/repositories";

/**
 * Tracking mode of a repository card: "Releases", "Releases + tags" or "Files / folders", plus a
 * popover to edit the watched paths in "Files / folders" mode. Choosing "Files / folders" without
 * saved paths opens the editor first; the mode changes when the paths are saved.
 */
export function TrackModeToggle({
  subscriptionId,
  fullName,
  trackMode,
  watchedPaths,
}: {
  subscriptionId: string;
  fullName: string;
  trackMode: TrackModeValue;
  watchedPaths: string[];
}) {
  const [pending, startTransition] = useTransition();
  const [optimisticMode, setOptimisticMode] = useOptimistic(trackMode);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pathsText, setPathsText] = useState("");
  const [pathsError, setPathsError] = useState<string | null>(null);
  const inputId = useId();

  function save(mode: TrackModeValue, paths?: string[], onDone?: () => void) {
    startTransition(async () => {
      setOptimisticMode(mode);
      const result = await updateTrackModeAction({ subscriptionId, trackMode: mode, ...(paths ? { watchedPaths: paths } : {}) });
      if (!result.ok) {
        if (paths) setPathsError(result.error.message);
        else toast.error(result.error.message);
        return;
      }
      onDone?.();
      if (!result.data.importing) return;
      if (mode === "PATHS") {
        toast.info(`Importing commits of ${fullName}…`, {
          description: "Recent commits that change the watched paths appear in the feed in a moment.",
        });
      } else {
        toast.info(`Importing the Git tags of ${fullName}…`, {
          description: "Tags without a GitHub release appear in the feed in a moment.",
        });
      }
    });
  }

  function openEditor() {
    setPathsText(formatWatchedPaths(watchedPaths));
    setPathsError(null);
    setEditorOpen(true);
  }

  function changeMode(value: string) {
    if (!isTrackMode(value) || value === optimisticMode) return;
    // Paths are required: ask for them before switching.
    if (value === "PATHS" && watchedPaths.length === 0) {
      // After the select has closed and returned focus to its trigger, or the popover would
      // treat that focus move as an outside interaction and close again.
      setTimeout(openEditor, 0);
      return;
    }
    save(value);
  }

  function submitPaths(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateWatchedPaths(pathsText);
    if (!validation.ok) {
      setPathsError(validation.message);
      return;
    }
    save("PATHS", validation.paths, () => setEditorOpen(false));
  }

  const showPaths = optimisticMode === "PATHS" || editorOpen;

  return (
    <div className="flex items-center gap-1.5">
      <dt className="sr-only">Tracking</dt>
      <dd className="flex flex-wrap items-center gap-1.5">
        <Select value={optimisticMode} onValueChange={changeMode} disabled={pending}>
          <SelectTrigger className="h-6 gap-1 px-2 text-xs" aria-label={`Tracking mode of ${fullName}`}>
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

        {showPaths ? (
          <Popover
            open={editorOpen}
            onOpenChange={(next) => {
              if (pending) return;
              if (next) openEditor();
              else setEditorOpen(false);
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 max-w-56 gap-1 px-1.5 text-xs font-normal text-muted-foreground"
                title={watchedPaths.length > 0 ? `Watching ${watchedPaths.join(", ")}` : undefined}
                aria-label={`Edit the watched files and folders of ${fullName}`}
              >
                <FolderIcon className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate font-mono">{watchedPaths.length > 0 ? summarizeWatchedPaths(watchedPaths) : "Choose paths"}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 p-3">
              <form onSubmit={submitPaths} className="grid gap-2">
                <Label htmlFor={inputId} className="text-xs font-medium">
                  Watched files and folders
                </Label>
                <Input
                  id={inputId}
                  value={pathsText}
                  onChange={(e) => setPathsText(e.target.value)}
                  placeholder={WATCHED_PATHS_PLACEHOLDER}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  className="h-8 font-mono text-xs"
                  aria-invalid={pathsError ? true : undefined}
                  aria-describedby={`${inputId}-help`}
                />
                <p id={`${inputId}-help`} className="text-xs text-muted-foreground">
                  Relative to the repository root, separated by commas (up to {MAX_WATCHED_PATHS}). A folder matches every file inside it.
                </p>
                {pathsError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {pathsError}
                  </p>
                ) : null}
                <div className="mt-1 flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditorOpen(false)} disabled={pending}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={pending || !pathsText.trim()}>
                    {pending ? "Saving…" : "Save"}
                  </Button>
                </div>
              </form>
            </PopoverContent>
          </Popover>
        ) : null}
      </dd>
    </div>
  );
}
