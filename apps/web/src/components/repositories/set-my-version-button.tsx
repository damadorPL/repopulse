"use client";

import { CheckIcon, PackageCheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { repositorySettingsHref } from "@/lib/repo-list-filters";
import { updateSubscriptionSettingsAction } from "@/server/actions/repositories";

/**
 * "Set as my version" in the reader (Slice 07): stores the release's tag as the version the user
 * runs, so newer releases get a "Newer than yours" marker and the repository shows how far behind it is.
 * When active, opens a popover explaining the feature with direct links to edit or remove it.
 */
export function SetMyVersionButton({
  subscriptionId,
  fullName,
  tagName,
  isMyVersion,
  onVersionChange,
}: {
  subscriptionId: string;
  fullName: string;
  tagName: string;
  isMyVersion: boolean;
  onVersionChange?: (currentVersion: string | null) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [mine, setMine] = useOptimistic(isMyVersion);

  function set() {
    startTransition(async () => {
      setMine(true);
      const result = await updateSubscriptionSettingsAction({ subscriptionId, currentVersion: tagName });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      onVersionChange?.(tagName);
      toast.success(`Your version of ${fullName} is ${tagName}`, {
        description:
          "Newer releases are marked in the feed. Click “Your version” or open repository settings to edit or remove it.",
      });
    });
  }

  function clear() {
    startTransition(async () => {
      setMine(false);
      const result = await updateSubscriptionSettingsAction({ subscriptionId, currentVersion: null });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      setOpen(false);
      onVersionChange?.(null);
      toast.success(`Removed your version of ${fullName}`);
    });
  }

  if (mine) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" title="Manage your tracked version for this repository">
            <CheckIcon />
            Your version
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 space-y-3 p-3.5">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              Your version: <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs">{tagName}</code>
            </p>
            <p className="text-xs text-muted-foreground">
              Tracks the version of {fullName} you currently run. Newer releases are marked “Newer than yours” in the
              feed, and Tracked Repositories shows how far behind you are (filter by “My version” to see them all).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href={repositorySettingsHref(fullName, undefined, "my-version")} prefetch={false}>
                Edit in settings
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={clear}
              disabled={pending}
            >
              Remove
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={set}
      disabled={pending}
      title="Track this as the version you currently run. Newer releases will be marked in the feed."
    >
      <PackageCheckIcon />
      Set as my version
    </Button>
  );
}
