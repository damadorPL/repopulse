"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, CopyIcon, LinkIcon, LoaderCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { INVITE_EXPIRY_DAYS, INVITE_NOTE_MAX_LENGTH } from "@/lib/invites";
import { createInviteAction } from "@/server/actions/access";

function expiryLabel(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

export function CreateInviteForm() {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<string>("7");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createInviteAction({ note, expiresInDays: Number(expiresInDays) });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError(result.error.message);
        return;
      }
      setLink(`${window.location.origin}/invite/${result.data.token}`);
      setCopied(false);
      setNote("");
    });
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success("Invite link copied");
    } catch {
      toast.error("Couldn't copy. Select the link and copy it manually.");
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-lg border bg-card p-4 sm:p-5" aria-labelledby="create-invite-heading">
      <div>
        <h2 id="create-invite-heading" className="font-medium">
          Create invite link
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">Each link creates one account, then stops working.</p>
      </div>

      <div className="grid items-start gap-4 sm:grid-cols-[1fr_12rem]">
        <div className="grid gap-2">
          <Label htmlFor="invite-note">
            Note <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="invite-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Who is this for?"
            maxLength={INVITE_NOTE_MAX_LENGTH}
            autoComplete="off"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="invite-expiry">Expires after</Label>
          <Select value={expiresInDays} onValueChange={setExpiresInDays}>
            <SelectTrigger id="invite-expiry" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INVITE_EXPIRY_DAYS.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {expiryLabel(days)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? <LoaderCircleIcon className="animate-spin" /> : <LinkIcon />}
          Create link
        </Button>
      </div>

      {link ? (
        <div className="grid gap-2 rounded-md border border-dashed bg-muted/30 p-3">
          <Label htmlFor="invite-link">New invite link</Label>
          <div className="flex gap-2">
            <Input
              id="invite-link"
              value={link}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-[13px]"
              spellCheck={false}
            />
            <Button type="button" variant="outline" onClick={() => void copy()}>
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Copy it now. For security only a hash is stored, so this link can&apos;t be shown again.
          </p>
        </div>
      ) : null}
    </form>
  );
}
