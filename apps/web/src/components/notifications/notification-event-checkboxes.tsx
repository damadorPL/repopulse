"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  isEventAllowedForScope,
  normalizeEvents,
  NOTIFICATION_EVENT_HINTS,
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_EVENTS,
  type NotificationEventValue,
} from "@/lib/notification-events";

/**
 * "Notify about" checkboxes of a notification rule (Slice 08). A tag-scoped rule supports only
 * releases (dependency projects have no tags), so the other two are disabled and shown unchecked.
 */
export function NotificationEventCheckboxes({
  idPrefix,
  value,
  onChange,
  tagScoped,
  disabled = false,
}: {
  idPrefix: string;
  value: readonly NotificationEventValue[];
  onChange: (next: NotificationEventValue[]) => void;
  tagScoped: boolean;
  disabled?: boolean;
}) {
  function toggle(event: NotificationEventValue, checked: boolean) {
    onChange(normalizeEvents(checked ? [...value, event] : value.filter((e) => e !== event)));
  }

  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">Notify about</legend>
      {NOTIFICATION_EVENTS.map((event) => {
        const allowed = isEventAllowedForScope(event, tagScoped);
        return (
          <Label key={event} htmlFor={`${idPrefix}-${event}`} className="items-start font-normal">
            <Checkbox
              id={`${idPrefix}-${event}`}
              className="mt-0.5"
              checked={allowed && value.includes(event)}
              disabled={disabled || !allowed}
              onCheckedChange={(checked) => toggle(event, checked === true)}
            />
            <span className={allowed ? "grid gap-0.5" : "grid gap-0.5 opacity-60"}>
              {NOTIFICATION_EVENT_LABELS[event]}
              <span className="text-xs text-muted-foreground">
                {allowed ? NOTIFICATION_EVENT_HINTS[event] : "Not available for rules limited to a tag: dependency projects have no tags."}
              </span>
            </span>
          </Label>
        );
      })}
      {value.length === 0 ? (
        <p role="alert" className="text-sm text-destructive">
          Choose at least one event.
        </p>
      ) : null}
    </fieldset>
  );
}
