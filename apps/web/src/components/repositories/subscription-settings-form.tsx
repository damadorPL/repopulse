"use client";

import { useEffect, useId, useOptimistic, useState, useTransition, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { BellOffIcon } from "lucide-react";
import { toast } from "sonner";
import { LocalDateTime } from "@/components/feed/relative-time";
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
import { formatVersionStatus, type VersionStatus } from "@/lib/version-compare";
import { updateSubscriptionSettingsAction } from "@/server/actions/repositories";

type Patch = Omit<SubscriptionSettingsInput, "subscriptionId">;

function Row({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[14rem_1fr] sm:items-start sm:gap-4">
      <div>
        {htmlFor ? <Label htmlFor={htmlFor}>{label}</Label> : <span className="text-sm font-medium">{label}</span>}
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="grid gap-1.5">{children}</div>
    </div>
  );
}

/** Local `YYYY-MM-DD` of a date, for `<input type="date">`. */
function dateInputValue(date: Date): string {
  return format(date, "yyyy-MM-dd");
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
  const [snoozeDate, setSnoozeDate] = useState("");
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const ids = { level: useId(), note: useId(), version: useId(), snooze: useId() };

  // Saved values changed (here, or "Set as my version" in the reader): follow them.
  const [saved, setSaved] = useState({ note, currentVersion });
  if (saved.note !== note || saved.currentVersion !== currentVersion) {
    setSaved({ note, currentVersion });
    setNoteDraft(note ?? "");
    setVersionDraft(currentVersion ?? "");
  }

  const snoozed = snoozedUntil !== null && new Date(snoozedUntil).getTime() > Date.now();
  // Today in the viewer's time zone; set after mount so the server render does not guess it.
  const [minDate, setMinDate] = useState<string | undefined>(undefined);
  useEffect(() => setMinDate(dateInputValue(new Date())), []);

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

  function errorFor(field: string) {
    return error?.field === field ? (
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
    ) : null;
  }

  function submitNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save("note", { note: noteDraft.trim() ? noteDraft : null }, noteDraft.trim() ? "Note saved" : "Note removed");
  }

  function submitVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = versionDraft.trim();
    save("version", { currentVersion: value || null }, value ? `Your version of ${fullName} is ${value}` : "Version cleared");
  }

  function snoozeUntilDate() {
    if (!snoozeDate) return;
    const [y, m, d] = snoozeDate.split("-").map(Number);
    // Through the end of the chosen day, in the viewer's time zone.
    const until = new Date(y!, m! - 1, d! + 1);
    save("snooze", { snoozedUntil: until.toISOString() }, `Notifications of ${fullName} snoozed until ${format(until, "PPp")}`);
  }

  const levelOption = NOTIFICATION_LEVEL_OPTIONS.find((option) => option.value === level);
  const noteDirty = noteDraft !== (note ?? "");
  const versionDirty = versionDraft.trim() !== (currentVersion ?? "");

  return (
    <div className="grid gap-6">
      <Row label="Notifications" htmlFor={ids.level} hint="Applied before your notification rules. The feed and unread count always update.">
        <Select
          value={level}
          onValueChange={(value) => {
            if (!isNotificationLevel(value) || value === level) return;
            const label = NOTIFICATION_LEVEL_OPTIONS.find((option) => option.value === value)!.label;
            save("level", { notificationLevel: value }, `${fullName}: ${label.toLowerCase()}`, () => setLevel(value));
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
        {errorFor("level")}
      </Row>

      <Row label="Snooze" htmlFor={ids.snooze} hint="Pause external notifications for a while. Nothing is sent for what happened meanwhile.">
        {snoozed ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-sm text-amber-800 dark:text-amber-300">
              <BellOffIcon className="size-3.5" aria-hidden />
              Snoozed until <LocalDateTime date={snoozedUntil!} />
            </span>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => save("snooze", { snoozedUntil: null }, "Snooze ended")}>
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
                  save("snooze", { snoozedUntil: until.toISOString() }, `Notifications of ${fullName} snoozed for ${preset.label}`);
                }}
              >
                {preset.label}
              </Button>
            ))}
            <div className="flex items-center gap-2">
              <Input
                id={ids.snooze}
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
        {errorFor("snooze")}
      </Row>

      <Row label="Note" htmlFor={ids.note} hint="Only you see it. Shown on the repository card and included in the list search.">
        <form onSubmit={submitNote} className="grid gap-2">
          <textarea
            id={ids.note}
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
            maxLength={NOTE_MAX_LENGTH}
            rows={3}
            placeholder="Why you track it, what blocks an upgrade…"
            className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={pending || !noteDirty}>
              Save note
            </Button>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {noteDraft.length.toLocaleString("en")} / {NOTE_MAX_LENGTH.toLocaleString("en")}
            </span>
          </div>
          {errorFor("note")}
        </form>
      </Row>

      {tracksReleases ? (
        <Row label="My version" htmlFor={ids.version} hint="The version you run. Releases newer than it are marked in the feed.">
          <form onSubmit={submitVersion} className="flex flex-wrap items-center gap-2">
            <Input
              id={ids.version}
              value={versionDraft}
              onChange={(event) => setVersionDraft(event.target.value)}
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
              <span className="text-sm text-muted-foreground">
                {versionStatus ? formatVersionStatus(versionStatus) : "No stored release matches this version."}
              </span>
            ) : null}
          </form>
          {errorFor("version")}
        </Row>
      ) : null}
    </div>
  );
}
