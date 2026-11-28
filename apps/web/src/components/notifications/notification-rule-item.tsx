"use client";

import { LoaderCircleIcon, PencilIcon, SendIcon, TrashIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useOptimistic, useState, useTransition, type SubmitEvent } from "react";
import { toast } from "sonner";

import {
  CHANNEL_INFO,
  channelLabel,
  isDeliverableChannel,
  type DeliverableChannel,
} from "@repopulse/notifications/channels";

import { TagDot, TagPill } from "@/components/feed/tag-pill";
import { ChannelIcon } from "@/components/notifications/channel-icon";
import { NotificationEventCheckboxes } from "@/components/notifications/notification-event-checkboxes";
import { sendTestWithToast } from "@/components/notifications/send-test";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  isEventAllowedForScope,
  NOTIFICATION_EVENT_LABELS,
  type NotificationEventValue,
} from "@/lib/notification-events";
import { cn } from "@/lib/utils";
import {
  deleteNotificationRuleAction,
  toggleNotificationRuleAction,
  updateNotificationRuleAction,
} from "@/server/actions/notifications";
import type { TagPill as TagPillData } from "@/server/queries/feed";
import type { NotificationRuleView } from "@/server/queries/notifications";

const ALL = "__all__";

interface EditRuleDraft {
  scope: string;
  destination: string;
  onlyMajor: boolean;
  events: NotificationEventValue[];
}

function createRuleDraft(rule: NotificationRuleView, isEmail: boolean): EditRuleDraft {
  return {
    scope: rule.tag?.id ?? ALL,
    destination: isEmail && !rule.usesAccountEmail ? rule.destination : "",
    onlyMajor: rule.onlyMajorReleases,
    events: rule.events,
  };
}

function resolveEditScopeTags(rule: NotificationRuleView, tags: TagPillData[]): TagPillData[] {
  if (!rule.tag || tags.some((tag) => tag.id === rule.tag?.id)) return tags;
  return [...tags, rule.tag];
}

function computeRulePatch(params: {
  rule: NotificationRuleView;
  draft: EditRuleDraft;
  initial: EditRuleDraft;
  isEmail: boolean;
  smtpConfigured: boolean;
  pending: boolean;
}) {
  const { rule, draft, initial, isEmail, smtpConfigured, pending } = params;
  const tagScoped = draft.scope !== ALL;
  const effectiveEvents = draft.events.filter((event) => isEventAllowedForScope(event, tagScoped));
  const scopeChanged = draft.scope !== initial.scope;
  const onlyMajorChanged = draft.onlyMajor !== initial.onlyMajor;
  const eventsChanged =
    effectiveEvents.length !== rule.events.length ||
    effectiveEvents.some((event, index) => event !== rule.events[index]);
  const destinationChanged = isEmail
    ? draft.destination.trim() !== initial.destination
    : draft.destination.trim() !== "";
  const dirty = scopeChanged || onlyMajorChanged || eventsChanged || destinationChanged;
  const saveBlocked =
    pending || effectiveEvents.length === 0 || !dirty || (isEmail && destinationChanged && !smtpConfigured);

  return {
    tagScoped,
    effectiveEvents,
    saveBlocked,
    patch: {
      ...(scopeChanged ? { tagId: draft.scope === ALL ? null : draft.scope } : {}),
      ...(destinationChanged ? { destinationUrl: draft.destination } : {}),
      ...(onlyMajorChanged ? { onlyMajorReleases: draft.onlyMajor } : {}),
      ...(eventsChanged ? { events: effectiveEvents } : {}),
    },
  };
}

export function NotificationRuleItem({
  rule,
  tags,
  smtpConfigured,
  canConfigureSmtp = false,
}: {
  rule: NotificationRuleView;
  tags: TagPillData[];
  smtpConfigured: boolean;
  canConfigureSmtp?: boolean;
}) {
  const router = useRouter();
  const label = channelLabel(rule.channel);
  const [enabled, setOptimisticEnabled] = useOptimistic(rule.enabled);
  const [toggling, startToggle] = useTransition();
  const [testing, startTest] = useTransition();

  function toggle(next: boolean) {
    startToggle(async () => {
      setOptimisticEnabled(next);
      const result = await toggleNotificationRuleAction({ ruleId: rule.id, enabled: next });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      toast.success(next ? `${label} rule enabled` : `${label} rule paused`);
    });
  }

  function test() {
    startTest(async () => {
      await sendTestWithToast(rule.id, label);
    });
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
              <TagPill
                name={rule.tag.name}
                colorHex={rule.tag.colorHex}
                title={`Repositories tagged “${rule.tag.name}”`}
              />
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
              <Badge className="rounded-full border-transparent bg-red-500/10 text-[11px] text-red-700 dark:text-red-400">
                Major only
              </Badge>
            ) : null}
            {!enabled ? (
              <Badge variant="secondary" className="rounded-full text-[11px]">
                Paused
              </Badge>
            ) : null}
          </div>
        </div>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Switch
          checked={enabled}
          disabled={toggling}
          onCheckedChange={toggle}
          aria-label={`${enabled ? "Disable" : "Enable"} ${label} rule`}
          title={enabled ? "Enabled" : "Disabled"}
        />
        <EditRuleButton
          rule={rule}
          label={label}
          tags={tags}
          smtpConfigured={smtpConfigured}
          canConfigureSmtp={canConfigureSmtp}
        />
        <Button variant="outline" size="sm" onClick={test} disabled={testing}>
          {testing ? <LoaderCircleIcon className="motion-safe:animate-spin" /> : <SendIcon />}
          Send Test
        </Button>
        <DeleteRuleButton ruleId={rule.id} label={label} />
      </div>
    </li>
  );
}

function EditRuleScopeField({
  id,
  value,
  tags,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  tags: TagPillData[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Repositories</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All repositories</SelectItem>
          {tags.map((tag) => (
            <SelectItem key={tag.id} value={tag.id}>
              <TagDot color={tag.colorHex} />
              Tagged “{tag.name}”
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function EditRuleDestinationField({
  id,
  channel,
  currentDestination,
  value,
  onChange,
  pending,
  smtpConfigured,
  canConfigureSmtp,
  invalid,
}: {
  id: string;
  channel: DeliverableChannel | null;
  currentDestination: string;
  value: string;
  onChange: (next: string) => void;
  pending: boolean;
  smtpConfigured: boolean;
  canConfigureSmtp: boolean;
  invalid: boolean;
}) {
  if (!channel) return null;
  const info = CHANNEL_INFO[channel];
  const isEmail = info.destination === "email";
  const emailUnavailable = isEmail && !smtpConfigured;

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>
        {isEmail ? info.destinationLabel : `New ${info.destinationLabel.toLowerCase()} (optional)`}
      </Label>
      <Input
        id={id}
        type={isEmail ? "email" : "url"}
        inputMode={isEmail ? "email" : "url"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={isEmail ? info.placeholder : "Leave empty to keep current URL"}
        autoComplete="off"
        spellCheck={false}
        disabled={pending || emailUnavailable}
        className="font-mono text-[13px]"
        aria-invalid={invalid ? true : undefined}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {emailUnavailable ? (
          canConfigureSmtp ? (
            <>
              Email needs an SMTP server.{" "}
              <Link href="/admin/email" className="font-medium text-foreground underline underline-offset-2">
                Set it up in Admin → Email
              </Link>
              .
            </>
          ) : (
            "Email isn't set up on this RepoPulse instance yet. Ask the super admin to configure SMTP."
          )
        ) : isEmail ? (
          info.hint
        ) : (
          <>
            Current: <code className="font-mono text-[11px]">{currentDestination}</code>. Leave empty to keep it.
          </>
        )}
      </p>
    </div>
  );
}

function EditRuleMajorCheckbox({
  id,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Label htmlFor={id} className="items-start font-normal">
      <Checkbox
        id={id}
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <span className="grid gap-0.5">
        Only major releases
        <span className="text-xs text-muted-foreground">
          Skip minor, patch and pre-releases (for example v2.0.0, but not v2.0.1). Dependency notifications follow each
          project&apos;s own notification level.
        </span>
      </span>
    </Label>
  );
}

function EditRuleForm({
  rule,
  label,
  tags,
  smtpConfigured,
  canConfigureSmtp,
  pending,
  onPendingChange,
  onSaved,
}: {
  rule: NotificationRuleView;
  label: string;
  tags: TagPillData[];
  smtpConfigured: boolean;
  canConfigureSmtp: boolean;
  pending: boolean;
  onPendingChange: (start: () => Promise<void>) => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const ids = { scope: useId(), dest: useId(), major: useId() };
  const channel = isDeliverableChannel(rule.channel) ? rule.channel : null;
  const isEmail = channel !== null && CHANNEL_INFO[channel].destination === "email";
  const initial = createRuleDraft(rule, isEmail);
  const scopeTags = resolveEditScopeTags(rule, tags);

  const [draft, setDraft] = useState<EditRuleDraft>(() => createRuleDraft(rule, isEmail));
  const [error, setError] = useState<string | null>(null);

  const { tagScoped, effectiveEvents, saveBlocked, patch } = computeRulePatch({
    rule,
    draft,
    initial,
    isEmail,
    smtpConfigured,
    pending,
  });

  function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    onPendingChange(async () => {
      const result = await updateNotificationRuleAction({ ruleId: rule.id, ...patch });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError(result.error.message);
        toast.error(result.error.message);
        return;
      }
      onSaved();
      toast.success(`${label} rule updated`);
    });
  }

  return (
    <form onSubmit={save} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Edit {label} rule</DialogTitle>
        <DialogDescription>
          Update which repositories trigger this rule, where alerts go, and which events are sent.
        </DialogDescription>
      </DialogHeader>

      <EditRuleScopeField
        id={ids.scope}
        value={draft.scope}
        tags={scopeTags}
        disabled={pending}
        onChange={(scope) => setDraft((current) => ({ ...current, scope }))}
      />

      <EditRuleDestinationField
        id={ids.dest}
        channel={channel}
        currentDestination={rule.destination}
        value={draft.destination}
        onChange={(destination) => {
          setDraft((current) => ({ ...current, destination }));
          setError(null);
        }}
        pending={pending}
        smtpConfigured={smtpConfigured}
        canConfigureSmtp={canConfigureSmtp}
        invalid={error !== null}
      />

      <NotificationEventCheckboxes
        idPrefix={`rule-${rule.id}-event`}
        value={effectiveEvents}
        onChange={(events) => {
          setDraft((current) => ({ ...current, events }));
          setError(null);
        }}
        tagScoped={tagScoped}
        disabled={pending}
      />

      <EditRuleMajorCheckbox
        id={ids.major}
        checked={draft.onlyMajor}
        disabled={pending}
        onChange={(onlyMajor) => setDraft((current) => ({ ...current, onlyMajor }))}
      />

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={pending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={saveBlocked}>
          {pending ? <LoaderCircleIcon className="motion-safe:animate-spin" /> : null}
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditRuleButton({
  rule,
  label,
  tags,
  smtpConfigured,
  canConfigureSmtp,
}: {
  rule: NotificationRuleView;
  label: string;
  tags: TagPillData[];
  smtpConfigured: boolean;
  canConfigureSmtp: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Edit ${label} rule`}>
          <PencilIcon />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        {open ? (
          <EditRuleForm
            rule={rule}
            label={label}
            tags={tags}
            smtpConfigured={smtpConfigured}
            canConfigureSmtp={canConfigureSmtp}
            pending={pending}
            onPendingChange={(run) => startTransition(run)}
            onSaved={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DeleteRuleButton({ ruleId, label }: { ruleId: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      const result = await deleteNotificationRuleAction({ ruleId });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      setOpen(false);
      toast.success(`${label} rule deleted`);
    });
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      pending={pending}
      trigger={
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-destructive"
          aria-label={`Delete ${label} rule`}
        >
          <TrashIcon />
        </Button>
      }
      title={`Delete this ${label} rule?`}
      description="New releases will no longer be sent to this destination. Notifications already on their way are dropped."
      confirmLabel="Delete rule"
      pendingLabel="Deleting…"
      onConfirm={remove}
    />
  );
}
