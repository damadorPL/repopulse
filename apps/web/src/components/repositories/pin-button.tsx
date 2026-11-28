"use client";

import { PinIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { updateSubscriptionSettingsAction } from "@/server/actions/repositories";

/** Pins a repository to the top of `/repositories` (Slice 07). */
export function PinButton({
  subscriptionId,
  fullName,
  isPinned,
  withLabel = false,
}: {
  subscriptionId: string;
  fullName: string;
  isPinned: boolean;
  withLabel?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pinned, setPinned] = useOptimistic(isPinned);
  const label = pinned ? `Unpin ${fullName}` : `Pin ${fullName} to the top`;

  function toggle() {
    const nextPinned = !pinned;
    startTransition(async () => {
      setPinned(nextPinned);
      const result = await updateSubscriptionSettingsAction({ subscriptionId, isPinned: nextPinned });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      toast.success(nextPinned ? `Pinned ${fullName}` : `Unpinned ${fullName}`);
    });
  }

  return (
    <Button
      variant={withLabel ? "outline" : "ghost"}
      size={withLabel ? "sm" : "icon-sm"}
      onClick={toggle}
      disabled={pending}
      aria-pressed={pinned}
      aria-label={withLabel ? undefined : label}
      title={label}
      className={cn(!withLabel && (pinned ? "text-foreground" : "text-muted-foreground"))}
    >
      <PinIcon className={cn(pinned && "fill-current")} />
      {withLabel ? (pinned ? "Pinned" : "Pin") : null}
    </Button>
  );
}
