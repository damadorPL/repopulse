"use client";

import { CheckIcon, LoaderCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ReactNode, type SubmitEvent } from "react";
import { toast } from "sonner";

import { TagDot } from "@/components/feed/tag-pill";
import { WatchedPathsPicker } from "@/components/repositories/watched-paths-picker";
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
import { feedHref } from "@/lib/feed-filters";
import { isExpandedCombobox } from "@/lib/repo-paths";
import {
  NOTHING_TRACKED_MESSAGE,
  PATHS_OPTION,
  TRACK_MODE_OPTIONS,
  tracksSomething,
  type TrackModeValue,
} from "@/lib/track-modes";
import { cn } from "@/lib/utils";
import { validateWatchedPaths } from "@/lib/watched-paths";
import { addRepositoryAction } from "@/server/actions/repositories";
import type { TagPill } from "@/server/queries/feed";

type TrackingChoice = Exclude<TrackModeValue, "NONE"> | "PATHS";

/** The tracking choices of the dialog: one release mode at most, plus "Files / folders". */
const TRACKING_CHOICES: ReadonlyArray<{ key: TrackingChoice; label: string; hint: string }> = [
  ...TRACK_MODE_OPTIONS.flatMap((option) =>
    option.value === "NONE" ? [] : [{ key: option.value, label: option.label, hint: option.hint }],
  ),
  { key: "PATHS", label: PATHS_OPTION.label, hint: PATHS_OPTION.hint },
];

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function describeAddedRepository(
  data: { releasesCount: number; commitsCount: number; importingPaths: boolean },
  tracksReleases: boolean,
  trackMode: TrackModeValue,
  tracksPaths: boolean,
): string {
  const parts: string[] = [];
  if (tracksReleases) parts.push(`${plural(data.releasesCount, "release")} imported.`);
  if (trackMode === "TAGS_AND_COMMITS") parts.push("Git tags without a release are imported in the background.");
  if (tracksPaths) {
    parts.push(
      data.importingPaths
        ? "Recent commits that change the watched paths are imported in the background."
        : `${plural(data.commitsCount, "matching commit")} found.`,
    );
  }
  return parts.join(" ");
}

function TrackingChoicesFieldset({
  trackMode,
  tracksPaths,
  tracksAnything,
  onChoose,
}: {
  trackMode: TrackModeValue;
  tracksPaths: boolean;
  tracksAnything: boolean;
  onChoose: (key: TrackingChoice, checked: boolean) => void;
}) {
  return (
    <fieldset className="grid gap-2" aria-describedby="add-repo-tracking-help">
      <legend className="mb-2 text-sm font-medium">What to track</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {TRACKING_CHOICES.map((choice) => {
          const selected = choice.key === "PATHS" ? tracksPaths : trackMode === choice.key;
          return (
            <label
              key={choice.key}
              className={cn(
                "relative grid cursor-pointer gap-0.5 rounded-md border p-2.5 pr-8 text-sm transition-colors has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50",
                selected ? "border-foreground/40 bg-secondary" : "hover:bg-accent",
              )}
            >
              <input
                type="checkbox"
                name="add-repo-tracking"
                value={choice.key}
                checked={selected}
                onChange={(event) => onChoose(choice.key, event.target.checked)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={cn(
                  "absolute top-2.5 right-2.5 flex size-4 items-center justify-center rounded-[4px] border",
                  selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
                )}
              >
                {selected ? <CheckIcon className="size-3" /> : null}
              </span>
              <span className="font-medium">{choice.label}</span>
              <span className="text-xs text-muted-foreground">{choice.hint}</span>
            </label>
          );
        })}
      </div>
      <p
        id="add-repo-tracking-help"
        className={cn("text-xs", tracksAnything ? "text-muted-foreground" : "text-destructive")}
      >
        {tracksAnything ? "Pick releases or releases + tags, files / folders, or both." : NOTHING_TRACKED_MESSAGE}
      </p>
    </fieldset>
  );
}

function TagSelectorFieldset({
  tags,
  tagIds,
  onToggle,
}: {
  tags: TagPill[];
  tagIds: string[];
  onToggle: (id: string) => void;
}) {
  if (tags.length === 0) return null;
  const selectedTagIds = new Set(tagIds);

  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm font-medium">Tags</legend>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => {
          const selected = selectedTagIds.has(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onToggle(tag.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                selected ? "border-foreground/40 bg-secondary font-medium" : "text-muted-foreground hover:bg-accent",
              )}
            >
              <TagDot color={tag.colorHex} />
              {tag.name}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** "Add repository" dialog; `children` is the trigger element. `defaultRepo` prefills the repository field. */
export function AddRepoModal({
  tags,
  children,
  defaultRepo = "",
}: {
  tags: TagPill[];
  children: ReactNode;
  defaultRepo?: string;
}) {
  const router = useRouter();
  const repoInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState(defaultRepo);
  const [includePrereleases, setIncludePrereleases] = useState(false);
  const [trackMode, setTrackMode] = useState<TrackModeValue>("RELEASES");
  const [tracksPaths, setTracksPaths] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [pathsDraft, setPathsDraft] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pathsError, setPathsError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const tracksReleases = trackMode !== "NONE";
  const tracksAnything = tracksSomething(trackMode, tracksPaths);

  function reset() {
    setRepo(defaultRepo);
    setIncludePrereleases(false);
    setTrackMode("RELEASES");
    setTracksPaths(false);
    setPaths([]);
    setPathsDraft("");
    setTagIds([]);
    setError(null);
    setPathsError(null);
  }

  /** "Releases only" and "Releases + tags" exclude each other; "Files / folders" combines with either. */
  function choose(key: TrackingChoice, checked: boolean) {
    if (key === "PATHS") setTracksPaths(checked);
    else setTrackMode(checked ? key : "NONE");
    setPathsError(null);
  }

  function toggleTag(id: string) {
    setTagIds((current) => (current.includes(id) ? current.filter((t) => t !== id) : [...current, id]));
  }

  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPathsError(null);
    if (!tracksAnything) return;
    let watchedPaths: string[] = [];
    if (tracksPaths) {
      // Include text typed but not yet added as a chip.
      const validation = validateWatchedPaths([...paths, pathsDraft]);
      if (!validation.ok) {
        setPathsError(validation.message);
        return;
      }
      watchedPaths = validation.paths;
    }
    startTransition(async () => {
      const result = await addRepositoryAction({
        repoUrlOrSlug: repo,
        // Commits have no pre-release flag.
        includePrereleases: tracksReleases ? includePrereleases : false,
        trackMode,
        trackPaths: tracksPaths,
        watchedPaths,
        tagIds,
      });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError(result.error.message);
        toast.error(result.error.message);
        return;
      }
      const { fullName, repositoryId } = result.data;
      toast.success(`Now tracking ${fullName}`, {
        description: describeAddedRepository(result.data, tracksReleases, trackMode, tracksPaths),
        action: { label: "View", onClick: () => router.push(feedHref({ repositoryId })) },
      });
      setOpen(false);
      reset();
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
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          repoInputRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => isExpandedCombobox(event.target) && event.preventDefault()}
      >
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Track a repository</DialogTitle>
            <DialogDescription>
              Paste a GitHub URL or <code className="text-xs">owner/repo</code>, then choose what to follow.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="add-repo-input">Repository</Label>
            <Input
              ref={repoInputRef}
              id="add-repo-input"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="vercel/next.js or https://github.com/vercel/next.js"
              autoComplete="off"
              spellCheck={false}
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "add-repo-error" : undefined}
            />
            {error ? (
              <p id="add-repo-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <TrackingChoicesFieldset
            trackMode={trackMode}
            tracksPaths={tracksPaths}
            tracksAnything={tracksAnything}
            onChoose={choose}
          />

          {tracksPaths ? (
            <div className="grid gap-2">
              <Label htmlFor="add-repo-paths">Files or folders</Label>
              <WatchedPathsPicker
                id="add-repo-paths"
                repo={repo.trim() || null}
                debounceMs={600}
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
                describedBy="add-repo-paths-help"
              />
              <p id="add-repo-paths-help" className="text-xs text-muted-foreground">
                Type to search the default branch, or browse its folders. A folder matches every file inside it. Each
                commit that changes a watched path shows up with its changed files.
              </p>
            </div>
          ) : null}

          {tracksReleases ? (
            <Label className="font-normal">
              <Checkbox checked={includePrereleases} onCheckedChange={(v) => setIncludePrereleases(v === true)} />
              Include pre-releases (alpha, beta, rc)
            </Label>
          ) : null}

          <TagSelectorFieldset tags={tags} tagIds={tagIds} onToggle={toggleTag} />

          <DialogFooter>
            <Button
              type="submit"
              disabled={
                pending || !repo.trim() || !tracksAnything || (tracksPaths && paths.length === 0 && !pathsDraft.trim())
              }
            >
              {pending ? <LoaderCircleIcon className="motion-safe:animate-spin" /> : null}
              {pending ? (tracksReleases ? "Fetching releases…" : "Adding…") : "Add repository"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
