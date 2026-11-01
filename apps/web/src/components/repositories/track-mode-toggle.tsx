"use client";

import { useOptimistic, useTransition } from "react";
import type { TrackMode } from "@repopulse/db";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { updateTrackModeAction } from "@/server/actions/repositories";

/** "Tags" toggle on a repository card: switches between "Releases only" and "Releases + tags". */
export function TrackModeToggle({
  subscriptionId,
  fullName,
  trackMode,
}: {
  subscriptionId: string;
  fullName: string;
  trackMode: TrackMode;
}) {
  const [pending, startTransition] = useTransition();
  const [optimisticMode, setOptimisticMode] = useOptimistic(trackMode);
  const checked = optimisticMode === "TAGS_AND_COMMITS";

  function change(next: boolean) {
    const mode: TrackMode = next ? "TAGS_AND_COMMITS" : "RELEASES";
    startTransition(async () => {
      setOptimisticMode(mode);
      const result = await updateTrackModeAction({ subscriptionId, trackMode: mode });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      if (result.data.importing) {
        toast.info(`Importing the Git tags of ${fullName}…`, {
          description: "Tags without a GitHub release appear in the feed in a moment.",
        });
      }
    });
  }

  return (
    <div className="flex items-center gap-1">
      <dt className="sr-only">Tracking</dt>
      <dd>
        <Label
          className="cursor-pointer gap-1.5 text-xs font-normal text-muted-foreground"
          title="Also track Git tags that have no GitHub release (notes list the commits since the previous tag)"
        >
          <Checkbox
            className="size-3.5"
            checked={checked}
            disabled={pending}
            onCheckedChange={(value) => change(value === true)}
            aria-label={`Track Git tags of ${fullName}`}
          />
          Tags
        </Label>
      </dd>
    </div>
  );
}
