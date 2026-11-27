"use client";

import { RefreshCwIcon } from "lucide-react";
import { useTransition, type ComponentProps } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { formatWait } from "@/lib/format-wait";
import { syncToastId } from "@/lib/toast-ids";
import { cn } from "@/lib/utils";
import { triggerManualRepoSyncAction } from "@/server/actions/sync";

export function SyncRepoButton({
  repositoryId,
  label = "Sync now",
  iconOnly = false,
  ...props
}: { repositoryId: string; label?: string; iconOnly?: boolean } & Omit<ComponentProps<typeof Button>, "onClick">) {
  const [pending, startTransition] = useTransition();

  function sync() {
    startTransition(async () => {
      const result = await triggerManualRepoSyncAction({ repositoryId });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      const { data } = result;
      if (data.status === "COOLDOWN") {
        toast.info(`${data.fullName} was synced recently`, {
          description: `Manual syncs are limited to one every 5 minutes. Try again in ${formatWait(data.retryAfterSeconds)}.`,
        });
        return;
      }
      // The worker reports the outcome over SSE (SseListener), replacing this toast by id.
      // Loading toasts never expire on their own, so cap it in case no worker picks the job up.
      toast.loading(`Syncing ${data.fullName}…`, { id: syncToastId(repositoryId), duration: 60_000 });
    });
  }

  return (
    <Button
      variant="outline"
      size={iconOnly ? "icon-sm" : "sm"}
      onClick={sync}
      disabled={pending || props.disabled}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      {...props}
    >
      <RefreshCwIcon className={cn(pending && "motion-safe:animate-spin")} />
      {iconOnly ? null : pending ? "Syncing…" : label}
    </Button>
  );
}
