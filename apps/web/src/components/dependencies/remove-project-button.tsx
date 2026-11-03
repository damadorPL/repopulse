"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { removeDependencyProjectAction } from "@/server/actions/dependencies";

/** Danger zone: removes the project (and its PR ownership); open pull requests stay on GitHub. */
export function RemoveProjectButton({ projectId, fullName, redirectTo }: { projectId: string; fullName: string; redirectTo: string }) {
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
    <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm">
          <Trash2Icon />
          Remove project
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Stop checking {fullName}?</DialogTitle>
          <DialogDescription>
            Its dependency results, settings and pull request history in RepoPulse are removed, and RepoPulse stops managing pull
            requests for it. Open pull requests stay on GitHub. Tracking its releases is not affected.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" onClick={remove} disabled={pending}>
            {pending ? "Removing…" : "Remove project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
