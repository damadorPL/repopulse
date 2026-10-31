"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { CheckIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { TagDot } from "@/components/feed/tag-pill";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_TAG_COLOR, isHexColor, TAG_COLOR_PRESETS, TAG_NAME_MAX_LENGTH } from "@/lib/tags";
import { cn } from "@/lib/utils";
import { createTagAction, deleteTagAction, updateTagAction } from "@/server/actions/tags";
import type { SidebarTag } from "@/server/queries/feed";

/** Create, rename, recolor and delete tags; `children` is the trigger element. */
export function ManageTagsModal({ tags, children }: { tags: SidebarTag[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Categories &amp; tags</DialogTitle>
          <DialogDescription>Group repositories by topic and filter the feed with one click.</DialogDescription>
        </DialogHeader>

        <CreateTagForm />

        {tags.length > 0 ? (
          <ul className="-mx-2 grid gap-0.5" aria-label="Your tags">
            {tags.map((tag) => (
              <TagRow key={tag.id} tag={tag} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No tags yet. Create one above, then assign it on the Tracked Repositories page.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ColorPicker({ value, onChange, idPrefix }: { value: string; onChange: (hex: string) => void; idPrefix: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Tag color">
      {TAG_COLOR_PRESETS.map((color) => {
        const selected = value.toUpperCase() === color;
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={color}
            onClick={() => onChange(color)}
            className={cn(
              "flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected && "ring-2 ring-foreground/60",
            )}
            style={{ backgroundColor: color }}
          >
            {selected ? <CheckIcon className="size-3.5 text-white drop-shadow" /> : null}
          </button>
        );
      })}
      <label
        htmlFor={`${idPrefix}-custom-color`}
        className="relative flex size-6 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed text-[10px] text-muted-foreground"
        title="Custom color"
      >
        <span aria-hidden>+</span>
        <input
          id={`${idPrefix}-custom-color`}
          type="color"
          value={isHexColor(value) ? value : DEFAULT_TAG_COLOR}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label="Custom color"
        />
      </label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-24 font-mono text-xs"
        aria-label="Hex color"
        maxLength={7}
        aria-invalid={isHexColor(value) ? undefined : true}
      />
    </div>
  );
}

function CreateTagForm() {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(TAG_COLOR_PRESETS[0]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createTagAction({ name, colorHex: color });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      toast.success(`Created tag "${result.data.name}"`);
      setName("");
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-lg border bg-muted/30 p-3">
      <div className="grid gap-2">
        <Label htmlFor="new-tag-name">New tag</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <TagDot color={isHexColor(color) ? color : DEFAULT_TAG_COLOR} className="absolute left-3 top-1/2 size-2.5 -translate-y-1/2" />
            <Input
              id="new-tag-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Critical, Coolify Stack, UI Libraries"
              maxLength={TAG_NAME_MAX_LENGTH}
              className="pl-7"
              autoComplete="off"
              autoFocus
            />
          </div>
          <Button type="submit" disabled={pending || !name.trim() || !isHexColor(color)}>
            {pending ? "Adding…" : "Add"}
          </Button>
        </div>
      </div>
      <ColorPicker value={color} onChange={setColor} idPrefix="new-tag" />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function TagRow({ tag }: { tag: SidebarTag }) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm-delete">("view");
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.colorHex);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await updateTagAction({
        tagId: tag.id,
        ...(name.trim() !== tag.name ? { name } : {}),
        ...(color.toUpperCase() !== tag.colorHex.toUpperCase() ? { colorHex: color } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setMode("view");
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteTagAction({ tagId: tag.id });
      if (!result.ok) {
        toast.error(result.error.message);
        setMode("view");
        return;
      }
      toast.success(`Deleted tag "${tag.name}"`);
    });
  }

  if (mode === "edit") {
    const unchanged = name.trim() === tag.name && color.toUpperCase() === tag.colorHex.toUpperCase();
    return (
      <li className="rounded-md border p-3">
        <form onSubmit={save} className="grid gap-3">
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={TAG_NAME_MAX_LENGTH}
              aria-label="Tag name"
              autoFocus
            />
            <Button type="submit" size="icon" disabled={pending || unchanged || !name.trim() || !isHexColor(color)} aria-label="Save">
              <CheckIcon />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Cancel"
              onClick={() => {
                setName(tag.name);
                setColor(tag.colorHex);
                setError(null);
                setMode("view");
              }}
            >
              <XIcon />
            </Button>
          </div>
          <ColorPicker value={color} onChange={setColor} idPrefix={`tag-${tag.id}`} />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      </li>
    );
  }

  return (
    <li className="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/60">
      <TagDot color={tag.colorHex} className="size-2.5" />
      <span className="min-w-0 flex-1 truncate text-sm">{tag.name}</span>
      {mode === "confirm-delete" ? (
        <span className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">
            Delete{tag.repositoryCount > 0 ? ` (used by ${tag.repositoryCount})` : ""}?
          </span>
          <Button size="sm" variant="destructive" className="h-7" onClick={remove} disabled={pending}>
            Delete
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => setMode("view")} disabled={pending}>
            Keep
          </Button>
        </span>
      ) : (
        <>
          <span className="text-xs text-muted-foreground">
            {tag.repositoryCount} repo{tag.repositoryCount === 1 ? "" : "s"}
          </span>
          <Button size="icon-sm" variant="ghost" aria-label={`Edit ${tag.name}`} onClick={() => setMode("edit")}>
            <PencilIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Delete ${tag.name}`}
            className="hover:text-destructive"
            onClick={() => setMode("confirm-delete")}
          >
            <Trash2Icon />
          </Button>
        </>
      )}
    </li>
  );
}
