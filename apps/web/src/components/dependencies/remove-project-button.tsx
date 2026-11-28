"use client";

import { TrashIcon } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { removeDependencyProjectAction } from "@/server/actions/dependencies";

/** Danger zone: removes the project (and its PR ownership); open pull requests stay on GitHub. */
export function RemoveProjectButton({
  projectId,
  fullName,
  redirectTo,
}: {
  projectId: string;
  fullName: string;
  redirectTo: Route;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      const result = await removeDependencyProjectAction({ projectId });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      setOpen(false);
      toast.success(`Stopped checking ${fullName}`);
      router.push(redirectTo);
    });
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      pending={pending}
      trigger={
        <Button variant="destructive" size="sm">
          <TrashIcon />
          Remove project
        </Button>
      }
      title={`Stop checking ${fullName}?`}
      description="Its dependency results, settings and pull request history in RepoPulse are removed, and RepoPulse stops managing pull requests for it. Open pull requests stay on GitHub. Tracking its releases is not affected."
      confirmLabel="Remove project"
      pendingLabel="Removing…"
      onConfirm={remove}
    />
  );
}
