"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ExternalLinkIcon, KeyRoundIcon, LoaderCircleIcon, PlusIcon, RefreshCwIcon, SaveIcon, Trash2Icon, WebhookIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  GITHUB_APP_KEY_MAX_LENGTH,
  GITHUB_APP_NAME_MAX,
  githubAppWebhookSettingsUrls,
  type GitHubAppWebhookTarget,
} from "@/lib/github-app";
import { cn } from "@/lib/utils";
import {
  enableGitHubAppWebhooksAction,
  removeGitHubAppSettingsAction,
  saveGitHubAppSettingsAction,
  startGitHubAppManifestAction,
} from "@/server/actions/github-app";
import type { GitHubAppView } from "@/server/queries/github-app";

const textareaClass =
  "min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[12px] shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

function ErrorText({ children }: { children: string | null }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

export function GitHubAppStatusCard({ app }: { app: GitHubAppView }) {
  return (
    <section aria-labelledby="github-app-status" className="grid gap-4 rounded-lg border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="github-app-status" className="font-medium">
            {app.configured ? (app.slug ?? "GitHub App") : "No GitHub App yet"}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {app.configured
              ? "Members install this App on the repositories RepoPulse may open dependency update pull requests in."
              : "Dependency checks work without an App (notify only). Update pull requests and private repositories need one."}
          </p>
        </div>
        <Badge
          variant="secondary"
          className={cn(
            app.configured && app.keyReadable
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : app.configured
                ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "text-muted-foreground",
          )}
        >
          {app.configured ? (app.keyReadable ? "Configured" : "Key unreadable") : "Not configured"}
        </Badge>
      </div>

      {app.configured ? (
        <>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">App ID</dt>
              <dd className="font-mono tabular-nums">{app.appId}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Slug</dt>
              <dd className="font-mono">{app.slug}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Owner</dt>
              <dd>{app.owner ?? "Unknown"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Credentials</dt>
              <dd className="flex flex-wrap gap-1.5">
                <Badge variant="outline" className="rounded-full text-[11px]">
                  <KeyRoundIcon className="size-3" aria-hidden />
                  {app.keyReadable ? "Key saved" : "Key saved, can't be decrypted"}
                </Badge>
                <Badge variant="outline" className="rounded-full text-[11px] text-muted-foreground">
                  {app.webhookSecretSaved ? "Webhook secret saved" : "No webhook secret"}
                </Badge>
              </dd>
            </div>
          </dl>
          {!app.keyReadable ? (
            <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
              The saved private key can&apos;t be decrypted (was <code className="text-[12px]">TOKEN_ENCRYPTION_KEY</code> changed?).
              Generate a new key in the App&apos;s settings on GitHub and save it below.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {app.settingsUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={app.settingsUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLinkIcon />
                  App settings on GitHub
                </a>
              </Button>
            ) : null}
            {app.publicUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={app.publicUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLinkIcon />
                  Public page (install)
                </a>
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

/**
 * "Create GitHub App" (manifest flow): the Server Action sets the `state` cookie and returns the
 * GitHub URL and the manifest; this component then posts a plain form there (a top-level navigation,
 * so GitHub shows its "Create GitHub App" page).
 */
export function CreateGitHubAppForm({ appBaseUrl, replaces }: { appBaseUrl: string; replaces: boolean }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [organization, setOrganization] = useState("");
  const [name, setName] = useState("");
  const [target, setTarget] = useState<{ formUrl: string; manifest: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (target) formRef.current?.submit();
  }, [target]);

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await startGitHubAppManifestAction({ organization, name });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError(result.error.message);
        return;
      }
      setTarget(result.data);
    });
  }

  const redirecting = target !== null;

  return (
    <section aria-labelledby="github-app-create" className="grid gap-4 rounded-lg border bg-card p-4 sm:p-5">
      <div>
        <h2 id="github-app-create" className="font-medium">
          Create the GitHub App
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          GitHub creates a RepoPulse App from a prepared manifest (contents and pull requests: write, metadata: read; webhooks off) and
          sends you back here. {replaces ? "The new App replaces the current one." : null}
        </p>
      </div>
      <form onSubmit={start} className="grid gap-4">
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="github-app-org">Organization (optional)</Label>
            <Input
              id="github-app-org"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              placeholder="my-org"
              autoComplete="off"
              spellCheck={false}
              maxLength={39}
              disabled={pending || redirecting}
            />
            <p className="text-xs text-muted-foreground">Empty = owned by your personal GitHub account. You must be an owner of the organization.</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="github-app-name">App name (optional)</Label>
            <Input
              id="github-app-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="RepoPulse (your host)"
              autoComplete="off"
              maxLength={GITHUB_APP_NAME_MAX}
              disabled={pending || redirecting}
            />
            <p className="text-xs text-muted-foreground">Must be unique on GitHub. You can rename it on GitHub before creating it.</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Callback: <code className="break-all text-[11px]">{appBaseUrl}/api/github-app/manifest/callback</code>. It comes from{" "}
          <code className="text-[11px]">APP_BASE_URL</code>, which must be the address you use to open RepoPulse.
        </p>
        <ErrorText>{error}</ErrorText>
        <div>
          <Button type="submit" disabled={pending || redirecting}>
            {pending || redirecting ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
            {redirecting ? "Opening GitHub…" : "Create GitHub App"}
          </Button>
        </div>
      </form>
      {/* Posted by the effect above: GitHub expects `manifest=<json>` as a form field. */}
      <form ref={formRef} method="post" action={target?.formUrl} hidden aria-hidden>
        <input type="hidden" name="manifest" value={target?.manifest ?? ""} readOnly />
      </form>
    </section>
  );
}

/** Manual setup: an existing App (id, slug, private key), validated against GitHub before saving. */
export function ManualGitHubAppForm({ app }: { app: GitHubAppView }) {
  const router = useRouter();
  const [appId, setAppId] = useState(app.appId ? String(app.appId) : "");
  const [slug, setSlug] = useState(app.slug ?? "");
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await saveGitHubAppSettingsAction({
        // An empty field is NaN, so the server answers "Enter the App ID".
        appId: appId.trim() === "" ? Number.NaN : Number(appId),
        slug,
        privateKey,
        webhookSecret,
      });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError(result.error.message);
        return;
      }
      setPrivateKey("");
      setWebhookSecret("");
      toast.success("GitHub App saved", { description: `${result.data.slug} (owner: ${result.data.owner ?? "unknown"}) answered with this key.` });
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-lg border bg-card p-4 sm:p-5" aria-labelledby="github-app-manual">
      <div>
        <h2 id="github-app-manual" className="font-medium">
          Use an existing App
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Enter the App ID, the slug and a private key from the App&apos;s settings on GitHub. RepoPulse checks them with GitHub before saving.
        </p>
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="github-app-id">App ID</Label>
          <Input
            id="github-app-id"
            inputMode="numeric"
            value={appId}
            onChange={(e) => setAppId(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            autoComplete="off"
            required
            disabled={pending}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="github-app-slug">Slug</Label>
          <Input
            id="github-app-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="repopulse-example"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={pending}
          />
          <p className="text-xs text-muted-foreground">The last part of https://github.com/apps/&lt;slug&gt;.</p>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="github-app-key">Private key (.pem)</Label>
        <textarea
          id="github-app-key"
          className={textareaClass}
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----"}
          autoComplete="off"
          spellCheck={false}
          maxLength={GITHUB_APP_KEY_MAX_LENGTH}
          required
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">
          {app.keySaved ? "A key is saved; it is never shown again. Paste a key to replace it." : "Encrypted before it is stored, and never shown again."}
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="github-app-webhook-secret">Webhook secret (optional)</Label>
        <Input
          id="github-app-webhook-secret"
          type="password"
          value={webhookSecret}
          onChange={(e) => setWebhookSecret(e.target.value)}
          autoComplete="new-password"
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">
          {app.webhookSecretSaved ? "Empty keeps the saved secret for the same App." : "Only for an App whose webhook already has a secret. Otherwise leave it empty: “Enable webhooks” generates one."}
        </p>
      </div>
      <ErrorText>{error}</ErrorText>
      <div>
        <Button type="submit" disabled={pending || !appId || !slug.trim() || !privateKey.trim()}>
          {pending ? <LoaderCircleIcon className="animate-spin" /> : <SaveIcon />}
          {pending ? "Checking with GitHub…" : "Save App"}
        </Button>
      </div>
    </form>
  );
}

export function RemoveGitHubAppButton() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  function remove() {
    startTransition(async () => {
      const result = await removeGitHubAppSettingsAction();
      setConfirming(false);
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      toast.success("GitHub App removed", { description: "Delete it on GitHub too if you no longer need it." });
    });
  }

  return (
    <section aria-labelledby="github-app-remove" className="grid gap-3 rounded-lg border border-destructive/30 bg-card p-4 sm:p-5">
      <div>
        <h2 id="github-app-remove" className="font-medium">
          Remove the App from RepoPulse
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Forgets the App ID, slug, key and webhook secret. Projects keep checking in notify mode; update pull requests stop. The App stays on
          GitHub.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <Button type="button" variant="destructive" disabled={pending} onClick={remove}>
              {pending ? <LoaderCircleIcon className="animate-spin" /> : <Trash2Icon />}
              Remove GitHub App
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
            <Trash2Icon />
            Remove…
          </Button>
        )}
      </div>
    </section>
  );
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium underline underline-offset-2">
      {children}
      <ExternalLinkIcon className="size-3" aria-hidden />
    </a>
  );
}

/**
 * Part E: "Enable webhooks". The action sets the App's webhook URL and secret on GitHub; activating
 * the hook and subscribing to events can't be done through GitHub's API, so the steps are listed.
 */
export function GitHubAppWebhooksCard({ app, target }: { app: GitHubAppView; target: GitHubAppWebhookTarget }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const links = app.settingsUrl ? githubAppWebhookSettingsUrls(app.settingsUrl) : null;

  function enable(rotateSecret: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await enableGitHubAppWebhooksAction({ rotateSecret });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        setError(result.error.message);
        return;
      }
      setDone(true);
      toast.success(rotateSecret ? "Webhook secret replaced" : "Webhook URL and secret saved on GitHub", {
        description: "Finish on GitHub: tick Active, then subscribe to Push and Pull request.",
      });
    });
  }

  return (
    <section aria-labelledby="github-app-webhooks" className="grid gap-4 rounded-lg border bg-card p-4 sm:p-5">
      <div>
        <h2 id="github-app-webhooks" className="flex items-center gap-2 font-medium">
          <WebhookIcon className="size-4 text-muted-foreground" aria-hidden />
          Webhooks (optional)
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          With webhooks, a push that changes a manifest or lockfile on a project&apos;s default branch is checked right away, and merged or
          closed update pull requests are recorded at once. Without them, scheduled checks pick up the same changes later.
        </p>
      </div>

      {target.url ? (
        <>
          <p className="text-xs text-muted-foreground">
            Delivery URL: <code className="break-all text-[11px]">{target.url}</code>
          </p>
          <ol className="grid list-decimal gap-2 pl-5 text-sm">
            <li>
              <span className="font-medium">Enable webhooks</span> below. RepoPulse sets this URL and a webhook secret on the App (content type
              JSON, SSL verification on){app.webhookSecretSaved ? ", reusing the saved secret" : ""}.
            </li>
            <li>
              In the App&apos;s {links ? <ExternalLink href={links.general}>General settings</ExternalLink> : "General settings"}, under Webhook,
              tick <span className="font-medium">Active</span> and save. GitHub&apos;s API can&apos;t switch this on.
            </li>
            <li>
              In {links ? <ExternalLink href={links.events}>Permissions &amp; events</ExternalLink> : "Permissions & events"}, under Subscribe to
              events, tick <span className="font-medium">Push</span> and <span className="font-medium">Pull request</span> and save.
            </li>
            <li>
              Optional: {links ? <ExternalLink href={links.advanced}>Advanced</ExternalLink> : "Advanced"} lists recent deliveries. The ping GitHub
              sends after activation should show 204.
            </li>
          </ol>
          <ErrorText>{error}</ErrorText>
          {done ? (
            <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
              GitHub accepted the URL and the secret. Finish steps 2 and 3 on GitHub.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={pending || !app.keyReadable} onClick={() => enable(false)}>
              {pending ? <LoaderCircleIcon className="animate-spin" /> : <WebhookIcon />}
              Enable webhooks
            </Button>
            {app.webhookSecretSaved ? (
              <Button type="button" variant="outline" disabled={pending || !app.keyReadable} onClick={() => enable(true)}>
                <RefreshCwIcon />
                Replace the secret
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Not available here: {target.reason} Set <code className="text-[12px]">APP_BASE_URL</code> to the public https:// address of this
          instance to enable webhooks.
        </p>
      )}
    </section>
  );
}
