"use client";

import { useState, useTransition } from "react";
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
import { removeSubscriptionAction } from "@/server/actions/repositories";

export function RemoveSubscriptionButton({ subscriptionId, fullName }: { subscriptionId: string; fullName: string }) {
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
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={`Stop tracking ${fullName}`}>
          <Trash2Icon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Stop tracking {fullName}?</DialogTitle>
          <DialogDescription>
            Its releases disappear from your feed and its tag assignments are removed. You can add it again any time.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" onClick={remove} disabled={pending}>
            {pending ? "Removing…" : "Stop tracking"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
