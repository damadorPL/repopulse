"use client";

import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { setPublicRegistrationAction } from "@/server/actions/access";

export function RegistrationToggle({ publicRegistration }: { publicRegistration: boolean }) {
  const [enabled, setOptimisticEnabled] = useOptimistic(publicRegistration);
  const [pending, startTransition] = useTransition();

  function toggle(next: boolean) {
    startTransition(async () => {
      setOptimisticEnabled(next);
      const result = await setPublicRegistrationAction({ enabled: next });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success(next ? "Public registration turned on" : "Registration is now invite-only");
    });
  }

  return (
    <section aria-labelledby="registration-heading" className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4 sm:p-5">
      <div className="grid gap-1">
        <Label id="registration-heading" htmlFor="public-registration" className="text-base font-medium">
          Public registration
        </Label>
        <p className="text-sm text-muted-foreground">
          {enabled
            ? "Anyone with a GitHub account can create an account. Turn this off to make RepoPulse invite-only."
            : "Invite-only: new accounts need an invite link. Existing members can still sign in."}
        </p>
      </div>
      <Switch id="public-registration" className="mt-1" checked={enabled} disabled={pending} onCheckedChange={toggle} />
    </section>
  );
}
