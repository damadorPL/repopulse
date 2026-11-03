"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { depsScanToastId } from "@/components/realtime/sse-listener";
import { formatWait } from "@/components/repositories/sync-repo-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { triggerDependencyScanAction } from "@/server/actions/dependencies";

/**
 * "Check now": queues a priority dependency scan (5-minute cooldown). The outcome arrives over SSE
 * (`DEPS_SCAN_COMPLETED` / `DEPS_SCAN_FAILED`), which replaces the loading toast by id.
 */
export function CheckNowButton({
  projectId,
  fullName,
  iconOnly = false,
  busy = false,
}: {
  projectId: string;
  fullName: string;
  iconOnly?: boolean;
  /** A scan is already queued or running. */
  busy?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const label = `Check ${fullName} now`;

  function check() {
    startTransition(async () => {
      const result = await triggerDependencyScanAction({ projectId });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      const { data } = result;
      if (data.status === "COOLDOWN") {
        toast.info(`${data.fullName} was checked recently`, {
          description: `Checks are limited to one every 5 minutes. Try again in ${formatWait(data.retryAfterSeconds)}.`,
        });
        return;
      }
      toast.loading(`Checking the dependencies of ${data.fullName}…`, { id: depsScanToastId(projectId), duration: 120_000 });
    });
  }

  const spinning = pending || busy;
  return (
    <Button
      variant="outline"
      size={iconOnly ? "icon-sm" : "sm"}
      onClick={check}
      disabled={pending}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
    >
      <RefreshCwIcon className={cn(spinning && "animate-spin")} />
      {iconOnly ? null : busy ? "Checking…" : "Check now"}
    </Button>
  );
}
