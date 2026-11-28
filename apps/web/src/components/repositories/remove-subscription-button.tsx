"use client";

import { TrashIcon } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { removeSubscriptionAction } from "@/server/actions/repositories";

/**
 * "Stop tracking" with a confirmation dialog. `redirectTo` navigates away after removal (the
 * settings page of the repository no longer exists then); `withLabel` shows a full button.
 */
export function RemoveSubscriptionButton({
  subscriptionId,
  fullName,
  redirectTo,
  withLabel = false,
}: {
  subscriptionId: string;
  fullName: string;
  redirectTo?: Route;
  withLabel?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      const result = await removeSubscriptionAction({ subscriptionId });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      setOpen(false);
      toast.success(`Stopped tracking ${fullName}`);
      if (redirectTo) router.push(redirectTo);
    });
  }

  const trigger = withLabel ? (
    <Button variant="destructive" size="sm">
      <TrashIcon />
      Stop tracking
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground hover:text-destructive"
      aria-label={`Stop tracking ${fullName}`}
    >
      <TrashIcon />
    </Button>
  );

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      pending={pending}
      trigger={trigger}
      title={`Stop tracking ${fullName}?`}
      description="Its releases disappear from your feed and its tag assignments are removed. You can add it again any time."
      confirmLabel="Stop tracking"
      pendingLabel="Removing…"
      onConfirm={remove}
    />
  );
}
