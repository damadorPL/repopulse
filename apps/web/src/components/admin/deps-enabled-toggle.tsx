"use client";

import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { setDepsEnabledAction } from "@/server/actions/dependencies-admin";

export function DepsEnabledToggle({ enabled: savedEnabled }: { enabled: boolean }) {
  const router = useRouter();
  const [enabled, setOptimisticEnabled] = useOptimistic(savedEnabled);
  const [pending, startTransition] = useTransition();

  function toggle(next: boolean) {
    startTransition(async () => {
      setOptimisticEnabled(next);
      const result = await setDepsEnabledAction({ enabled: next });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      toast.success(next ? "Dependency checks turned on" : "Dependency checks turned off");
    });
  }

  return (
    <section aria-labelledby="deps-enabled-heading" className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4 sm:p-5">
      <div className="grid gap-1">
        <Label id="deps-enabled-heading" htmlFor="deps-enabled" className="text-base font-medium">
          Dependency checks
        </Label>
        <p className="text-sm text-muted-foreground">
          {enabled
            ? "Members see Dependencies in the sidebar, add their own repositories as projects and get notified about outdated npm, Bun and PyPI dependencies."
            : "Off: the Dependencies page is hidden and no checks run. Projects and their settings are kept for when it is turned on again."}
        </p>
      </div>
      <Switch id="deps-enabled" className="mt-1" checked={enabled} disabled={pending} onCheckedChange={toggle} />
    </section>
  );
}
