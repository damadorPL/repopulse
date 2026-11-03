"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, SendIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { channelLabel } from "@repopulse/notifications/channels";
import { TagPill } from "@/components/feed/tag-pill";
import { ChannelIcon } from "@/components/notifications/channel-icon";
import { NotificationEventCheckboxes } from "@/components/notifications/notification-event-checkboxes";
import { sendTestWithToast } from "@/components/notifications/send-test";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import { NOTIFICATION_EVENT_LABELS, type NotificationEventValue } from "@/lib/notification-events";
import { cn } from "@/lib/utils";
import {
  deleteNotificationRuleAction,
  toggleNotificationRuleAction,
  updateNotificationRuleEventsAction,
} from "@/server/actions/notifications";
import type { NotificationRuleView } from "@/server/queries/notifications";

export function NotificationRuleItem({ rule }: { rule: NotificationRuleView }) {
  const label = channelLabel(rule.channel);
  const [enabled, setOptimisticEnabled] = useOptimistic(rule.enabled);
  const [toggling, startToggle] = useTransition();
  const [testing, setTesting] = useState(false);

  function toggle(next: boolean) {
    startToggle(async () => {
      setOptimisticEnabled(next);
      const result = await toggleNotificationRuleAction({ ruleId: rule.id, enabled: next });
      if (!result.ok) toast.error(result.error.message);
    });
  }

  async function test() {
    setTesting(true);
    try {
      await sendTestWithToast(rule.id, label);
    } finally {
      setTesting(false);
    }
  }

  return (
    <li className={cn("flex flex-wrap items-center gap-x-4 gap-y-3 p-4", !enabled && "bg-muted/30")}>
      <div className={cn("flex min-w-0 flex-1 basis-64 items-start gap-3", !enabled && "opacity-60")}>
        <ChannelIcon channel={rule.channel} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{label}</p>
          <p className="truncate font-mono text-xs text-muted-foreground" title={rule.destination}>
            {rule.destination}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {rule.tag ? (
              <TagPill name={rule.tag.name} colorHex={rule.tag.colorHex} title={`Repositories tagged “${rule.tag.name}”`} />
            ) : (
              <Badge variant="outline" className="rounded-full text-[11px] font-medium text-muted-foreground">
                All repositories
              </Badge>
            )}
            {rule.events.map((event) => (
              <Badge key={event} variant="secondary" className="rounded-full text-[11px] font-medium">
                {NOTIFICATION_EVENT_LABELS[event]}
              </Badge>
            ))}
            {rule.onlyMajorReleases ? (
              <Badge className="rounded-full border-transparent bg-red-500/10 text-[11px] text-red-700 dark:text-red-400">Major only</Badge>
            ) : null}
            {!enabled ? (
              <Badge variant="secondary" className="rounded-full text-[11px]">
                Paused
              </Badge>
            ) : null}
          </div>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Switch
          checked={enabled}
          disabled={toggling}
          onCheckedChange={toggle}
          aria-label={`${enabled ? "Disable" : "Enable"} ${label} rule`}
          title={enabled ? "Enabled" : "Disabled"}
        />
        <EditEventsButton rule={rule} label={label} />
        <Button variant="outline" size="sm" onClick={() => void test()} disabled={testing}>
          {testing ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />}
          Send Test
        </Button>
        <DeleteRuleButton ruleId={rule.id} label={label} />
      </div>
    </li>
  );
}

function EditEventsButton({ rule, label }: { rule: NotificationRuleView; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<NotificationEventValue[]>(rule.events);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await updateNotificationRuleEventsAction({ ruleId: rule.id, events });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError(result.error.message);
        return;
      }
      setOpen(false);
      toast.success(`${label} rule updated`);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) {
          setEvents(rule.events);
          setError(null);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Choose what the ${label} rule notifies about`}>
          <SlidersHorizontalIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>What should this {label} rule notify about?</DialogTitle>
          <DialogDescription>
            {rule.tag ? `This rule is limited to repositories tagged “${rule.tag.name}”, so it can only notify about releases.` : "Pick one or more."}
          </DialogDescription>
        </DialogHeader>
        <NotificationEventCheckboxes idPrefix={`rule-${rule.id}-event`} value={events} onChange={setEvents} tagScoped={rule.tag !== null} disabled={pending} />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={save} disabled={pending || events.length === 0}>
            {pending ? <LoaderCircleIcon className="animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteRuleButton({ ruleId, label }: { ruleId: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      const result = await deleteNotificationRuleAction({ ruleId });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      setOpen(false);
      toast.success(`${label} rule deleted`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={`Delete ${label} rule`}>
          <Trash2Icon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this {label} rule?</DialogTitle>
          <DialogDescription>New releases will no longer be sent to this destination. Notifications already on their way are dropped.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" onClick={remove} disabled={pending}>
            {pending ? "Deleting…" : "Delete rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
