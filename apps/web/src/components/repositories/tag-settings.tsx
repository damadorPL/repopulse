"use client";

import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Settings2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { TagPill } from "@/components/feed/tag-pill";
import { ManageTagsModal } from "@/components/modals/manage-tags-modal";
import { Button } from "@/components/ui/button";
import { assignTagsAction } from "@/server/actions/tags";
import type { SidebarTag, TagPill as TagPillData } from "@/server/queries/feed";
import { AssignTagsPopover } from "./assign-tags-popover";

/**
 * The Tags section of the repository settings page (Slice 07): the assigned tags with remove
 * buttons, the existing tag picker, and the tag manager.
 */
export function TagSettings({
  subscriptionId,
  fullName,
  assigned,
  allTags,
  sidebarTags,
}: {
  subscriptionId: string;
  fullName: string;
  assigned: TagPillData[];
  allTags: TagPillData[];
  /** Tags with counts, for the manage dialog. */
  sidebarTags: SidebarTag[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tags, setTags] = useOptimistic(assigned);

  function remove(tagId: string) {
    startTransition(async () => {
      const next = tags.filter((tag) => tag.id !== tagId);
      setTags(next);
      const result = await assignTagsAction({ subscriptionId, tagIds: next.map((tag) => tag.id) });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
      }
    });
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.length === 0 ? <span className="text-sm text-muted-foreground">No tags yet.</span> : null}
        {tags.map((tag) => (
          <TagPill key={tag.id} name={tag.name} colorHex={tag.colorHex} className="gap-1 py-0.5 pr-0.5">
            <button
              type="button"
              onClick={() => remove(tag.id)}
              disabled={pending}
              className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              aria-label={`Remove the tag ${tag.name} from ${fullName}`}
            >
              <XIcon className="size-3" />
            </button>
          </TagPill>
        ))}
        <AssignTagsPopover
          subscriptionId={subscriptionId}
          repositoryName={fullName}
          allTags={allTags}
          assignedTagIds={tags.map((tag) => tag.id)}
        />
        <ManageTagsModal tags={sidebarTags}>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground">
            <Settings2Icon className="size-3.5" />
            Manage tags
          </Button>
        </ManageTagsModal>
      </div>
      <p className="text-xs text-muted-foreground">
        Tags group repositories in the sidebar and feed. To send this repository&apos;s notifications to a specific channel, tag
        it and add a notification rule for that tag.
      </p>
    </div>
  );
}
