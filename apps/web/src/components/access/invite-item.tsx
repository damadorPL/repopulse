"use client";

import { useTransition } from "react";
import { LoaderCircleIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/feed/relative-time";
import { RepoAvatar } from "@/components/feed/repo-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { deleteInviteAction } from "@/server/actions/access";
import type { InviteView } from "@/server/queries/access";

const STATUS_BADGE: Record<InviteView["status"], { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  used: { label: "Used", className: "bg-secondary text-secondary-foreground" },
  expired: { label: "Expired", className: "bg-muted text-muted-foreground" },
};

export function InviteItem({ invite }: { invite: InviteView }) {
  const [pending, startTransition] = useTransition();
  const badge = STATUS_BADGE[invite.status];
  const isPending = invite.status === "pending";
  const action = isPending ? "Revoke" : "Remove";

  function remove() {
    startTransition(async () => {
      const result = await deleteInviteAction({ inviteId: invite.id });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success(isPending ? "Invite link revoked" : "Invite removed");
    });
  }

  return (
    <li className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 p-4", !isPending && "bg-muted/20")}>
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{invite.note ?? "Invite link"}</p>
          <Badge className={cn("rounded-full border-transparent text-[11px]", badge.className)}>{badge.label}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Created by {invite.createdBy} <RelativeTime date={invite.createdAt} />
          {" · "}
          {invite.status === "used" && invite.usedAt ? (
            <>
              used <RelativeTime date={invite.usedAt} />
            </>
          ) : (
            <>
              {isPending ? "expires" : "expired"} <RelativeTime date={invite.expiresAt} />
            </>
          )}
        </p>
      </div>

      {invite.usedBy ? (
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <RepoAvatar src={invite.usedBy.avatarUrl} name={invite.usedBy.name ?? invite.usedBy.email} className="size-6 rounded-full" />
          <span className="truncate">{invite.usedBy.name ?? invite.usedBy.email}</span>
        </div>
      ) : null}

      <Button
        variant="ghost"
        size="sm"
        className="ml-auto text-muted-foreground hover:text-destructive"
        onClick={remove}
        disabled={pending}
        aria-label={`${action} invite${invite.note ? ` “${invite.note}”` : ""}`}
      >
        {pending ? <LoaderCircleIcon className="animate-spin" /> : <Trash2Icon />}
        {action}
      </Button>
    </li>
  );
}
