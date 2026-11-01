"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, MailCheckIcon, PowerOffIcon, SaveIcon, SendIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SMTP_SECURITY, SMTP_SECURITY_HINTS, SMTP_SECURITY_LABELS, type SmtpSecurity } from "@/lib/smtp";
import { cn } from "@/lib/utils";
import { removeSmtpSettingsAction, saveSmtpSettingsAction, sendSmtpTestEmailAction } from "@/server/actions/email-settings";
import type { SmtpSettingsView } from "@/server/smtp-settings";

interface FormState {
  host: string;
  port: string;
  security: SmtpSecurity;
  user: string;
  from: string;
}

function toFormState(view: SmtpSettingsView): FormState {
  return { host: view.host, port: String(view.port), security: view.security, user: view.user, from: view.from };
}

export function SmtpSettingsForm({ settings, adminEmail }: { settings: SmtpSettingsView; adminEmail: string }) {
  const router = useRouter();
  const [saved, setSaved] = useState(settings);
  const [form, setForm] = useState<FormState>(() => toFormState(settings));
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [saving, startSaving] = useTransition();
  const [removing, startRemoving] = useTransition();
  const [testing, startTesting] = useTransition();

  const savedForm = toFormState(saved);
  const dirty =
    (Object.keys(form) as (keyof FormState)[]).some((key) => form[key].trim() !== savedForm[key].trim()) ||
    password !== "" ||
    clearPassword;
  const hasUser = form.user.trim() !== "";
  const busy = saving || removing;

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function applySaved(view: SmtpSettingsView) {
    setSaved(view);
    setForm(toFormState(view));
    setPassword("");
    setClearPassword(false);
  }

  function handleError(code: string, message: string) {
    if (code === "UNAUTHORIZED") router.push("/login");
    setError(message);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setConfirmingRemove(false);
    startSaving(async () => {
      const result = await saveSmtpSettingsAction({
        host: form.host,
        // An empty field is NaN, so the server answers "Enter a port" instead of trying port 0.
        port: form.port.trim() === "" ? Number.NaN : Number(form.port),
        security: form.security,
        user: form.user,
        password,
        clearPassword,
        from: form.from,
      });
      if (!result.ok) return handleError(result.error.code, result.error.message);
      const wasEnabled = saved.enabled;
      applySaved(result.data);
      toast.success(wasEnabled ? "SMTP settings saved" : "Email is on", {
        description: "Send a test email to check the connection.",
      });
    });
  }

  function remove() {
    setError(null);
    startRemoving(async () => {
      const result = await removeSmtpSettingsAction();
      setConfirmingRemove(false);
      if (!result.ok) return handleError(result.error.code, result.error.message);
      applySaved(result.data);
      toast.success("Email is off", { description: "The SMTP settings were removed." });
    });
  }

  function sendTest() {
    startTesting(async () => {
      const id = toast.loading("Sending a test email…");
      const result = await sendSmtpTestEmailAction({ to: testTo });
      if (result.ok) {
        toast.success("Test email sent", { id, description: `Accepted by the SMTP server for ${result.data.to}. Check the inbox.` });
        return;
      }
      if (result.error.code === "UNAUTHORIZED") router.push("/login");
      toast.error(result.error.code === "DELIVERY_FAILED" ? "Test email failed" : result.error.message, {
        id,
        description: result.error.code === "DELIVERY_FAILED" ? result.error.message : undefined,
      });
    });
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="grid gap-5 rounded-lg border bg-card p-4 sm:p-5" aria-labelledby="smtp-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="smtp-heading" className="font-medium">
              SMTP server
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Used for every email notification on this instance.</p>
          </div>
          <Badge
            variant="secondary"
            className={cn(saved.enabled ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}
          >
            {saved.enabled ? "Email on" : "Email off"}
          </Badge>
        </div>

        <div className="grid items-start gap-4 sm:grid-cols-[1fr_8rem]">
          <div className="grid gap-2">
            <Label htmlFor="smtp-host">Host</Label>
            <Input
              id="smtp-host"
              value={form.host}
              onChange={(e) => update("host", e.target.value)}
              placeholder="smtp.example.com"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={253}
              className="font-mono text-[13px]"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="smtp-port">Port</Label>
            <Input
              id="smtp-port"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={form.port}
              onChange={(e) => update("port", e.target.value)}
              required
              className="tabular-nums"
            />
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="smtp-security">Encryption</Label>
          <Select value={form.security} onValueChange={(value) => update("security", value as SmtpSecurity)}>
            <SelectTrigger id="smtp-security" className="w-full sm:w-64" aria-describedby="smtp-security-hint">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SMTP_SECURITY.map((value) => (
                <SelectItem key={value} value={value}>
                  {SMTP_SECURITY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p id="smtp-security-hint" className="text-xs text-muted-foreground">
            {SMTP_SECURITY_HINTS[form.security]}
          </p>
        </div>

        <div className="grid items-start gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="smtp-user">
              Username <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="smtp-user"
              value={form.user}
              onChange={(e) => update("user", e.target.value)}
              placeholder="releases@example.com"
              autoComplete="off"
              spellCheck={false}
              maxLength={320}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="smtp-password">Password</Label>
            <Input
              id="smtp-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={saved.hasPassword && !clearPassword ? "Saved. Leave empty to keep it" : ""}
              autoComplete="new-password"
              disabled={!hasUser || clearPassword}
              maxLength={1024}
              aria-describedby="smtp-password-hint"
            />
            {saved.hasPassword && hasUser ? (
              <Label className="font-normal text-muted-foreground">
                <Checkbox
                  checked={clearPassword}
                  onCheckedChange={(v) => {
                    setClearPassword(v === true);
                    if (v === true) setPassword("");
                  }}
                />
                Remove the saved password
              </Label>
            ) : (
              <p id="smtp-password-hint" className="text-xs text-muted-foreground">
                {hasUser ? "Stored encrypted and never shown again." : "Enter a username to sign in to the server."}
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="smtp-from">
            Sender <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="smtp-from"
            value={form.from}
            onChange={(e) => update("from", e.target.value)}
            placeholder={saved.defaultFrom ?? "RepoPulse <releases@example.com>"}
            autoComplete="off"
            spellCheck={false}
            maxLength={320}
            aria-describedby="smtp-from-hint"
          />
          <p id="smtp-from-hint" className="text-xs text-muted-foreground">
            An address, optionally with a name. Empty: <span className="font-mono">RepoPulse &lt;username&gt;</span> when the username is
            an address. Many providers only accept a sender they verified.
          </p>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy || !dirty}>
            {saving ? <LoaderCircleIcon className="animate-spin" /> : <SaveIcon />}
            {saved.enabled ? "Save changes" : "Turn on email"}
          </Button>
          {saved.enabled ? (
            confirmingRemove ? (
              <>
                <Button type="button" variant="destructive" disabled={busy} onClick={remove}>
                  {removing ? <LoaderCircleIcon className="animate-spin" /> : <PowerOffIcon />}
                  Remove SMTP settings
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirmingRemove(false)}>
                  Cancel
                </Button>
                <p className="basis-full text-xs text-muted-foreground">
                  Email rules stay, but stop delivering until SMTP is set up again.
                </p>
              </>
            ) : (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirmingRemove(true)}>
                <PowerOffIcon />
                Turn off email
              </Button>
            )
          ) : null}
        </div>
      </form>

      <section aria-labelledby="smtp-test-heading" className="grid gap-4 rounded-lg border bg-card p-4 sm:p-5">
        <div>
          <h2 id="smtp-test-heading" className="font-medium">
            Send a test email
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Delivers the sample v1.0.0 release through the saved settings.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Label htmlFor="smtp-test-to" className="sr-only">
            Recipient
          </Label>
          <Input
            id="smtp-test-to"
            type="email"
            inputMode="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder={adminEmail}
            autoComplete="off"
            spellCheck={false}
            disabled={!saved.enabled}
            className="sm:max-w-sm"
          />
          <Button type="button" variant="outline" disabled={!saved.enabled || dirty || testing} onClick={sendTest}>
            {testing ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />}
            Send test email
          </Button>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MailCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {!saved.enabled
            ? "Turn on email first."
            : dirty
              ? "Save your changes first: the test uses the saved settings."
              : `Leave the address empty to send it to ${adminEmail}.`}
        </p>
      </section>
    </div>
  );
}
