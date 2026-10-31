"use client";

import { useState, useTransition } from "react";
import { TagsIcon } from "lucide-react";
import { toast } from "sonner";
import { TagDot } from "@/components/feed/tag-pill";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { assignTagsAction } from "@/server/actions/tags";
import type { TagPill } from "@/server/queries/feed";

export function AssignTagsPopover({
  subscriptionId,
  repositoryName,
  allTags,
  assignedTagIds,
}: {
  subscriptionId: string;
  repositoryName: string;
  allTags: TagPill[];
  assignedTagIds: string[];
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(assignedTagIds);
  const [pending, startTransition] = useTransition();

  const changed =
    selected.length !== assignedTagIds.length || selected.some((id) => !assignedTagIds.includes(id));

  function toggle(id: string, checked: boolean) {
    setSelected((current) => (checked ? [...current, id] : current.filter((t) => t !== id)));
  }

  function save() {
    startTransition(async () => {
      const result = await assignTagsAction({ subscriptionId, tagIds: selected });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success(`Updated tags for ${repositoryName}`);
      setOpen(false);
    });
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSelected(assignedTagIds); // start from the server state each time
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground">
          <TagsIcon className="size-3.5" />
          Edit tags
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">Tags for {repositoryName}</p>
        {allTags.length === 0 ? (
          <p className="text-sm text-muted-foreground">Create a tag from the sidebar (“New Tag”) first.</p>
        ) : (
          <div className="grid max-h-64 gap-1 overflow-y-auto">
            {allTags.map((tag) => {
              const id = `assign-${subscriptionId}-${tag.id}`;
              return (
                <Label key={tag.id} htmlFor={id} className="rounded-md px-1.5 py-1.5 font-normal hover:bg-accent">
                  <Checkbox
                    id={id}
                    checked={selected.includes(tag.id)}
                    onCheckedChange={(checked) => toggle(tag.id, checked === true)}
                  />
                  <TagDot color={tag.colorHex} />
                  <span className="truncate">{tag.name}</span>
                </Label>
              );
            })}
          </div>
        )}
        {allTags.length > 0 ? (
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={pending || !changed}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
