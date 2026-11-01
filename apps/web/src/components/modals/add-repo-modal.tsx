"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { TagDot } from "@/components/feed/tag-pill";
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
import { TRACK_MODE_OPTIONS, type TrackModeValue } from "@/lib/track-modes";
import { cn } from "@/lib/utils";
import { MAX_WATCHED_PATHS, validateWatchedPaths, WATCHED_PATHS_PLACEHOLDER } from "@/lib/watched-paths";
import { addRepositoryAction } from "@/server/actions/repositories";
import type { TagPill } from "@/server/queries/feed";

/** "Add repository" dialog; `children` is the trigger element. */
export function AddRepoModal({ tags, children }: { tags: TagPill[]; children: ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState("");
  const [includePrereleases, setIncludePrereleases] = useState(false);
  const [trackMode, setTrackMode] = useState<TrackModeValue>("RELEASES");
  const [pathsText, setPathsText] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pathsError, setPathsError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const tracksPaths = trackMode === "PATHS";

  function reset() {
    setRepo("");
    setIncludePrereleases(false);
    setTrackMode("RELEASES");
    setPathsText("");
    setTagIds([]);
    setError(null);
    setPathsError(null);
  }

  function toggleTag(id: string) {
    setTagIds((current) => (current.includes(id) ? current.filter((t) => t !== id) : [...current, id]));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPathsError(null);
    let watchedPaths: string[] = [];
    if (tracksPaths) {
      const validation = validateWatchedPaths(pathsText);
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
        includePrereleases: tracksPaths ? false : includePrereleases,
        trackMode,
        watchedPaths,
        tagIds,
      });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError(result.error.message);
        return;
      }
      const { fullName, repositoryId, releasesCount, importing } = result.data;
      const counted = (word: string) => `${releasesCount} ${word}${releasesCount === 1 ? "" : "s"}`;
      let description = `${counted("release")} imported.`;
      if (trackMode === "TAGS_AND_COMMITS") description += " Git tags without a release are imported in the background.";
      if (tracksPaths) {
        description = importing
          ? "Recent commits that change the watched paths are imported in the background."
          : `${counted("matching commit")} found.`;
      }
      toast.success(`Now tracking ${fullName}`, {
        description,
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
      <DialogContent>
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
              id="add-repo-input"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="vercel/next.js or https://github.com/vercel/next.js"
              autoComplete="off"
              spellCheck={false}
              required
              autoFocus
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "add-repo-error" : undefined}
            />
            {error ? (
              <p id="add-repo-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Tracking mode</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {TRACK_MODE_OPTIONS.map((option) => {
                const selected = trackMode === option.value;
                return (
                  <label
                    key={option.value}
                    className={cn(
                      "grid cursor-pointer gap-0.5 rounded-md border p-2.5 text-sm transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50",
                      selected ? "border-foreground/40 bg-secondary" : "hover:bg-accent",
                    )}
                  >
                    <input
                      type="radio"
                      name="add-repo-track-mode"
                      value={option.value}
                      checked={selected}
                      onChange={() => {
                        setTrackMode(option.value);
                        setPathsError(null);
                      }}
                      className="sr-only"
                    />
                    <span className="font-medium">{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.hint}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {tracksPaths ? (
            <div className="grid gap-2">
              <Label htmlFor="add-repo-paths">Files or folders</Label>
              <Input
                id="add-repo-paths"
                value={pathsText}
                onChange={(e) => setPathsText(e.target.value)}
                placeholder={WATCHED_PATHS_PLACEHOLDER}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={pathsError ? true : undefined}
                aria-describedby={pathsError ? "add-repo-paths-help add-repo-paths-error" : "add-repo-paths-help"}
              />
              <p id="add-repo-paths-help" className="text-xs text-muted-foreground">
                Paths relative to the repository root, separated by commas (up to {MAX_WATCHED_PATHS}). A folder matches every file
                inside it. Each commit on the default branch that changes one of them shows up with its changed files.
              </p>
              {pathsError ? (
                <p id="add-repo-paths-error" role="alert" className="text-sm text-destructive">
                  {pathsError}
                </p>
              ) : null}
            </div>
          ) : (
            <Label className="font-normal">
              <Checkbox checked={includePrereleases} onCheckedChange={(v) => setIncludePrereleases(v === true)} />
              Include pre-releases (alpha, beta, rc)
            </Label>
          )}

          {tags.length > 0 ? (
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">Tags</legend>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => {
                  const selected = tagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleTag(tag.id)}
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
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending || !repo.trim() || (tracksPaths && !pathsText.trim())}>
              {pending ? <LoaderCircleIcon className="animate-spin" /> : null}
              {pending ? (tracksPaths ? "Adding…" : "Fetching releases…") : "Add repository"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
