"use client";

import { format } from "date-fns";
import { BellOffIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useOptimistic, useState, useTransition, type ReactNode, type SubmitEvent } from "react";
import { toast } from "sonner";

import { LocalDateTime } from "@/components/feed/relative-time";
import { useClientNow } from "@/components/repositories/use-client-now";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CURRENT_VERSION_MAX_LENGTH,
  isNotificationLevel,
  NOTE_MAX_LENGTH,
  NOTIFICATION_LEVEL_OPTIONS,
  SNOOZE_PRESETS,
  snoozeUntil,
  type NotificationLevelValue,
  type SubscriptionSettingsInput,
} from "@/lib/subscription-settings";
import { cn } from "@/lib/utils";
import { formatVersionStatus, type VersionStatus } from "@/lib/version-compare";
import { updateSubscriptionSettingsAction } from "@/server/actions/repositories";

type Patch = Omit<SubscriptionSettingsInput, "subscriptionId">;
type FieldErrorState = { field: string; message: string } | null;

function Row({
  anchorId,
  label,
  htmlFor,
  hint,
  children,
}: {
  anchorId?: string;
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div
      id={anchorId}
      className={cn("grid gap-1.5 sm:grid-cols-[14rem_1fr] sm:items-start sm:gap-4", anchorId && "scroll-mt-20")}
    >
      <div>
        {htmlFor ? <Label htmlFor={htmlFor}>{label}</Label> : <span className="text-sm font-medium">{label}</span>}
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="grid gap-1.5">{children}</div>
    </div>
  );
}

function FieldError({ error, field }: { error: FieldErrorState; field: string }) {
  if (error?.field !== field) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {error.message}
    </p>
  );
}

/** Local `YYYY-MM-DD` of a date, for `<input type="date">`. */
function dateInputValue(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function SnoozeControl({
  id,
  fullName,
  snoozed,
  snoozedUntil,
  minDate,
  pending,
  error,
  onSave,
}: {
  id: string;
  fullName: string;
  snoozed: boolean;
  snoozedUntil: string | null;
  minDate: string | undefined;
  pending: boolean;
  error: FieldErrorState;
  onSave: (field: string, patch: Patch, success: string) => void;
}) {
  const [snoozeDate, setSnoozeDate] = useState("");

  function snoozeUntilDate() {
    if (!snoozeDate) return;
    const [y, m, d] = snoozeDate.split("-").map(Number);
    // Through the end of the chosen day, in the viewer's time zone.
    const until = new Date(y!, m! - 1, d! + 1);
    onSave(
      "snooze",
      { snoozedUntil: until.toISOString() },
      `Notifications of ${fullName} snoozed until ${format(until, "PPp")}`,
    );
  }

  return (
    <Row
      label="Snooze"
      htmlFor={id}
      hint="Pause external notifications for a while. Nothing is sent for what happened meanwhile."
    >
      {snoozed && snoozedUntil ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-sm text-amber-800 dark:text-amber-300">
            <BellOffIcon className="size-3.5" aria-hidden />
            Snoozed until <LocalDateTime date={snoozedUntil} />
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onSave("snooze", { snoozedUntil: null }, "Snooze ended")}
          >
            End snooze
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {SNOOZE_PRESETS.map((preset) => (
            <Button
              key={preset.key}
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => {
                const until = snoozeUntil(preset.days);
                onSave(
                  "snooze",
                  { snoozedUntil: until.toISOString() },
                  `Notifications of ${fullName} snoozed for ${preset.label}`,
                );
              }}
            >
              {preset.label}
            </Button>
          ))}
          <div className="flex items-center gap-2">
            <Input
              id={id}
              type="date"
              value={snoozeDate}
              min={minDate}
              onChange={(event) => setSnoozeDate(event.target.value)}
              className="h-8 w-40"
              aria-label="Snooze until the end of"
            />
            <Button variant="outline" size="sm" disabled={pending || !snoozeDate} onClick={snoozeUntilDate}>
              Snooze until
            </Button>
          </div>
        </div>
      )}
      <FieldError error={error} field="snooze" />
    </Row>
  );
}

function NoteRow({
  id,
  noteDraft,
  noteDirty,
  pending,
  error,
  onChange,
  onSubmit,
}: {
  id: string;
  noteDraft: string;
  noteDirty: boolean;
  pending: boolean;
  error: FieldErrorState;
  onChange: (value: string) => void;
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
}) {
  return (
    <Row
      label="Note"
      htmlFor={id}
      hint="Only you see it. Shown on the repository card and included in the list search."
    >
      <form onSubmit={onSubmit} className="grid gap-2">
        <textarea
          id={id}
          value={noteDraft}
          onChange={(event) => onChange(event.target.value)}
          maxLength={NOTE_MAX_LENGTH}
          rows={3}
          placeholder="Why you track it, what blocks an upgrade…"
          className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-hidden placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
        />
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={pending || !noteDirty}>
            Save note
          </Button>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {noteDraft.length.toLocaleString("en")} / {NOTE_MAX_LENGTH.toLocaleString("en")}
          </span>
        </div>
        <FieldError error={error} field="note" />
      </form>
    </Row>
  );
}

function MyVersionRow({
  id,
  versionDraft,
  versionDirty,
  currentVersion,
  versionStatus,
  pending,
  error,
  onChange,
  onSubmit,
  onClear,
}: {
  id: string;
  versionDraft: string;
  versionDirty: boolean;
  currentVersion: string | null;
  versionStatus: VersionStatus | null;
  pending: boolean;
  error: FieldErrorState;
  onChange: (value: string) => void;
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  onClear: () => void;
}) {
  return (
    <Row
      anchorId="my-version"
      label="My version"
      htmlFor={id}
      hint="The version you currently run. Marked as “Your version” in the feed, with newer releases labeled “Newer than yours” and your status shown on Tracked Repositories (filter by “My version”)."
    >
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          value={versionDraft}
          onChange={(event) => onChange(event.target.value)}
          maxLength={CURRENT_VERSION_MAX_LENGTH}
          placeholder="v2.4.1"
          autoComplete="off"
          spellCheck={false}
          className="h-8 w-48 font-mono"
        />
        <Button type="submit" size="sm" disabled={pending || !versionDirty}>
          Save
        </Button>
        {currentVersion ? (
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onClear}>
            Remove
          </Button>
        ) : null}
        {currentVersion ? (
          <span className="text-sm text-muted-foreground">
            {versionStatus ? formatVersionStatus(versionStatus) : "No stored release matches this version."}
          </span>
        ) : null}
      </form>
      <FieldError error={error} field="version" />
    </Row>
  );
}

/**
 * The "Notifications & feed" section of the repository settings page (Slice 07): notification
 * level, snooze, personal note and "my version". Each field saves on its own through
 * `updateSubscriptionSettingsAction`.
 */
export function SubscriptionSettingsForm({
  subscriptionId,
  fullName,
  tracksReleases,
  notificationLevel,
  snoozedUntil,
  note,
  currentVersion,
  versionStatus,
}: {
  subscriptionId: string;
  fullName: string;
  /** "My version" compares releases and tags: hidden for a files / folders only subscription. */
  tracksReleases: boolean;
  notificationLevel: NotificationLevelValue;
  snoozedUntil: string | null;
  note: string | null;
  currentVersion: string | null;
  versionStatus: VersionStatus | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [level, setLevel] = useOptimistic(notificationLevel);
  const [noteDraft, setNoteDraft] = useState(note ?? "");
  const [versionDraft, setVersionDraft] = useState(currentVersion ?? "");
  const [error, setError] = useState<FieldErrorState>(null);
  const ids = { level: useId(), note: useId(), version: useId(), snooze: useId() };

  // Saved values changed (here, or "Set as my version" in the reader): follow them.
  const [saved, setSaved] = useState({ note, currentVersion });
  if (saved.note !== note || saved.currentVersion !== currentVersion) {
    setSaved({ note, currentVersion });
    setNoteDraft(note ?? "");
    setVersionDraft(currentVersion ?? "");
  }

  const clientNow = useClientNow();
  const snoozed = snoozedUntil !== null && clientNow !== null && new Date(snoozedUntil).getTime() > clientNow.getTime();
  // Today in the viewer's time zone; derived on the client so SSR and hydration match.
  const minDate = clientNow ? dateInputValue(clientNow) : undefined;

  function save(field: string, patch: Patch, success: string, optimistic?: () => void) {
    setError(null);
    startTransition(async () => {
      optimistic?.();
      const result = await updateSubscriptionSettingsAction({ subscriptionId, ...patch });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError({ field, message: result.error.message });
        toast.error(result.error.message);
        return;
      }
      toast.success(success);
    });
  }

  function submitNote(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    save("note", { note: noteDraft.trim() ? noteDraft : null }, noteDraft.trim() ? "Note saved" : "Note removed");
  }

  function submitVersion(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = versionDraft.trim();
    save(
      "version",
      { currentVersion: value || null },
      value ? `Your version of ${fullName} is ${value}` : `Removed your version of ${fullName}`,
    );
  }

  function clearVersion() {
    save("version", { currentVersion: null }, `Removed your version of ${fullName}`);
  }

  const levelOption = NOTIFICATION_LEVEL_OPTIONS.find((option) => option.value === level);

  return (
    <div className="grid gap-6">
      <Row
        label="Notifications"
        htmlFor={ids.level}
        hint="Applied before your notification rules. The feed and unread count always update."
      >
        <Select
          value={level}
          onValueChange={(value) => {
            if (!isNotificationLevel(value) || value === level) return;
            const option = NOTIFICATION_LEVEL_OPTIONS.find((o) => o.value === value);
            if (!option) return;
            save("level", { notificationLevel: value }, `${fullName}: ${option.label.toLowerCase()}`, () =>
              setLevel(value),
            );
          }}
          disabled={pending}
        >
          <SelectTrigger id={ids.level} className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NOTIFICATION_LEVEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {levelOption?.hint} Commits count as “other” updates.{" "}
          <Link href="/settings/notifications" className="font-medium text-foreground hover:underline">
            Notification rules
          </Link>
        </p>
        <FieldError error={error} field="level" />
      </Row>

      <SnoozeControl
        id={ids.snooze}
        fullName={fullName}
        snoozed={snoozed}
        snoozedUntil={snoozedUntil}
        minDate={minDate}
        pending={pending}
        error={error}
        onSave={save}
      />

      <NoteRow
        id={ids.note}
        noteDraft={noteDraft}
        noteDirty={noteDraft !== (note ?? "")}
        pending={pending}
        error={error}
        onChange={setNoteDraft}
        onSubmit={submitNote}
      />

      {tracksReleases ? (
        <MyVersionRow
          id={ids.version}
          versionDraft={versionDraft}
          versionDirty={versionDraft.trim() !== (currentVersion ?? "")}
          currentVersion={currentVersion}
          versionStatus={versionStatus}
          pending={pending}
          error={error}
          onChange={setVersionDraft}
          onSubmit={submitVersion}
          onClear={clearVersion}
        />
      ) : null}
    </div>
  );
}
