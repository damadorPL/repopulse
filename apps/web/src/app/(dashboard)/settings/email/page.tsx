import type { Metadata } from "next";
import { ShieldCheckIcon } from "lucide-react";
import { SmtpSettingsForm } from "@/components/email/smtp-settings-form";
import { requireSuperAdmin } from "@/server/session";
import { getSmtpSettingsView } from "@/server/smtp-settings";

export const metadata: Metadata = { title: "Email · RepoPulse" };

export default async function EmailSettingsPage() {
  const admin = await requireSuperAdmin();
  const settings = await getSmtpSettingsView();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Email</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The SMTP server RepoPulse sends email notifications through. Members can add email rules once it is set up.
        </p>
      </div>

      <SmtpSettingsForm settings={settings} adminEmail={admin.email} />

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          The password is encrypted with <code className="text-[11px]">TOKEN_ENCRYPTION_KEY</code> and never sent back to the browser.
          Changes apply to the worker right away, without a restart.
        </span>
      </p>
    </div>
  );
}
