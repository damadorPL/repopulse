"use client";

import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { CHANNEL_INFO, DELIVERABLE_CHANNELS, type DeliverableChannel } from "@repopulse/notifications/channels";
import { TagDot } from "@/components/feed/tag-pill";
import { ChannelGlyph } from "@/components/notifications/channel-icon";
import { sendTestWithToast } from "@/components/notifications/send-test";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NotificationEventCheckboxes } from "@/components/notifications/notification-event-checkboxes";
import { DEFAULT_NOTIFICATION_EVENTS, isEventAllowedForScope, NOTIFICATION_EVENT_LABELS, type NotificationEventValue } from "@/lib/notification-events";
import { createNotificationRuleAction } from "@/server/actions/notifications";
import type { TagPill } from "@/server/queries/feed";

/** Radix Select can't hold an empty value, so "all repositories" gets a sentinel. */
const ALL = "__all__";

export function AddNotificationRuleForm({
  tags,
  smtpConfigured,
  canConfigureSmtp = false,
  limitReached,
}: {
  tags: TagPill[];
  smtpConfigured: boolean;
  /** The super admin gets a link to Admin → Email when SMTP isn't set up. */
  canConfigureSmtp?: boolean;
  limitReached: boolean;
}) {
  const router = useRouter();
  const [channel, setChannel] = useState<DeliverableChannel>("DISCORD_WEBHOOK");
  const [scope, setScope] = useState<string>(ALL);
  const [destination, setDestination] = useState("");
  const [onlyMajor, setOnlyMajor] = useState(false);
  const [events, setEvents] = useState<NotificationEventValue[]>(DEFAULT_NOTIFICATION_EVENTS);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const info = CHANNEL_INFO[channel];
  const isEmail = info.destination === "email";
  const emailUnavailable = isEmail && !smtpConfigured;
  const tagScoped = scope !== ALL;
  /** Tag-scoped rules support only releases: what the form shows is what gets sent. */
  const effectiveEvents = events.filter((event) => isEventAllowedForScope(event, tagScoped));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createNotificationRuleAction({
        tagId: scope === ALL ? null : scope,
        channel,
        destinationUrl: destination,
        onlyMajorReleases: onlyMajor,
        events: effectiveEvents,
      });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError(result.error.message);
        return;
      }
      const rule = result.data;
      const label = CHANNEL_INFO[channel].label;
      const what = rule.events.map((event) => NOTIFICATION_EVENT_LABELS[event]).join(", ");
      toast.success(`${label} rule added`, {
        description: rule.tag ? `${what} of repositories tagged “${rule.tag.name}”.` : `${what} of all your repositories.`,
        action: { label: "Send test", onClick: () => void sendTestWithToast(rule.id, label) },
      });
      setDestination("");
      setOnlyMajor(false);
      setEvents(DEFAULT_NOTIFICATION_EVENTS);
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-lg border bg-card p-4 sm:p-5" aria-labelledby="add-rule-heading">
      <div>
        <h2 id="add-rule-heading" className="font-medium">
          Add notification rule
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">Choose where alerts go and which repositories trigger them.</p>
      </div>

      {/* items-start: the Repositories column can carry a hint, which would otherwise stretch the Channel column. */}
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="rule-channel">Channel</Label>
          <Select
            value={channel}
            onValueChange={(value) => {
              setChannel(value as DeliverableChannel);
              setDestination("");
              setError(null);
            }}
          >
            <SelectTrigger id="rule-channel" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DELIVERABLE_CHANNELS.map((value) => (
                <SelectItem key={value} value={value}>
                  <ChannelGlyph channel={value} className="text-muted-foreground" />
                  {CHANNEL_INFO[value].label}
                  {value === "EMAIL_INSTANT" && !smtpConfigured ? (
                    <span className="text-xs text-muted-foreground">· SMTP not configured</span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="rule-scope">Repositories</Label>
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger id="rule-scope" className="w-full">
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
          {tags.length === 0 ? (
            <p className="text-xs text-muted-foreground">Create tags in the sidebar to limit a rule to some repositories.</p>
          ) : null}
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="rule-destination">{info.destinationLabel}</Label>
        <Input
          id="rule-destination"
          type={isEmail ? "email" : "url"}
          inputMode={isEmail ? "email" : "url"}
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder={info.placeholder}
          autoComplete="off"
          spellCheck={false}
          required={!isEmail}
          disabled={emailUnavailable}
          className="font-mono text-[13px]"
          aria-invalid={error ? true : undefined}
          aria-describedby="rule-destination-hint"
        />
        <p id="rule-destination-hint" className="text-xs text-muted-foreground">
          {!emailUnavailable ? (
            info.hint
          ) : canConfigureSmtp ? (
            <>
              Email needs an SMTP server.{" "}
              <Link href="/admin/email" className="font-medium text-foreground underline underline-offset-2">
                Set it up in Admin → Email
              </Link>
              .
            </>
          ) : (
            "Email isn't set up on this RepoPulse instance yet. Ask the super admin to configure SMTP."
          )}
        </p>
      </div>

      <NotificationEventCheckboxes idPrefix="rule-event" value={effectiveEvents} onChange={setEvents} tagScoped={tagScoped} />

      <Label className="items-start font-normal">
        <Checkbox className="mt-0.5" checked={onlyMajor} onCheckedChange={(v) => setOnlyMajor(v === true)} />
        <span className="grid gap-0.5">
          Only major releases
          <span className="text-xs text-muted-foreground">Skip minor, patch and pre-releases (for example v2.0.0, but not v2.0.1). Dependency notifications follow each project's own notification level.</span>
        </span>
      </Label>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          disabled={pending || emailUnavailable || limitReached || effectiveEvents.length === 0 || (!isEmail && !destination.trim())}
        >
          {pending ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
          {pending ? "Checking destination…" : "Add rule"}
        </Button>
        {limitReached ? <p className="text-sm text-muted-foreground">Rule limit reached. Delete a rule to add another.</p> : null}
      </div>
    </form>
  );
}
