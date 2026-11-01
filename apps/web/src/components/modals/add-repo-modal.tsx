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
import { cn } from "@/lib/utils";
import { addRepositoryAction } from "@/server/actions/repositories";
import type { TagPill } from "@/server/queries/feed";

/** "Add repository" dialog; `children` is the trigger element. */
export function AddRepoModal({ tags, children }: { tags: TagPill[]; children: ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState("");
  const [includePrereleases, setIncludePrereleases] = useState(false);
  const [trackTags, setTrackTags] = useState(false);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setRepo("");
    setIncludePrereleases(false);
    setTrackTags(false);
    setTagIds([]);
    setError(null);
  }

  function toggleTag(id: string) {
    setTagIds((current) => (current.includes(id) ? current.filter((t) => t !== id) : [...current, id]));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await addRepositoryAction({
        repoUrlOrSlug: repo,
        includePrereleases,
        trackMode: trackTags ? "TAGS_AND_COMMITS" : "RELEASES",
        tagIds,
      });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError(result.error.message);
        return;
      }
      const { fullName, repositoryId, releasesCount } = result.data;
      toast.success(`Now tracking ${fullName}`, {
        description:
          `${releasesCount} release${releasesCount === 1 ? "" : "s"} imported.` +
          (trackTags ? " Git tags without a release are imported in the background." : ""),
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
              Paste a GitHub URL or <code className="text-xs">owner/repo</code>. The latest releases are imported right away.
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

          <Label className="font-normal">
            <Checkbox checked={includePrereleases} onCheckedChange={(v) => setIncludePrereleases(v === true)} />
            Include pre-releases (alpha, beta, rc)
          </Label>

          <Label className="items-start font-normal">
            <Checkbox className="mt-0.5" checked={trackTags} onCheckedChange={(v) => setTrackTags(v === true)} />
            <span className="grid gap-0.5">
              Also track Git tags without a GitHub release
              <span className="text-xs text-muted-foreground">For projects that only push tags. Their notes list the commits since the previous tag.</span>
            </span>
          </Label>

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
            <Button type="submit" disabled={pending || !repo.trim()}>
              {pending ? <LoaderCircleIcon className="animate-spin" /> : null}
              {pending ? "Fetching releases…" : "Add repository"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
