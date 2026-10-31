"use client";

import { useTransition, type ComponentProps } from "react";
import { RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { triggerManualRepoSyncAction } from "@/server/actions/sync";

function formatWait(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest.toString().padStart(2, "0")}s` : `${rest}s`;
}

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
      } else if (data.status === "NOT_MODIFIED" || data.newReleases === 0) {
        toast.success(`${data.fullName} is up to date`);
      } else {
        toast.success(`${data.newReleases} new release${data.newReleases === 1 ? "" : "s"} in ${data.fullName}`);
      }
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
      <RefreshCwIcon className={cn(pending && "animate-spin")} />
      {iconOnly ? null : pending ? "Syncing…" : label}
    </Button>
  );
}
