import type { Metadata } from "next";
import { CheckCircle2Icon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { resolveAppBaseUrl } from "@repopulse/notifications";
import {
  CreateGitHubAppForm,
  GitHubAppStatusCard,
  GitHubAppWebhooksCard,
  ManualGitHubAppForm,
  RemoveGitHubAppButton,
} from "@/components/admin/github-app-settings";
import { callbackErrorMessage, githubAppWebhookTarget } from "@/lib/github-app";
import { getGitHubAppView } from "@/server/queries/github-app";
import { requireSuperAdmin } from "@/server/session";

export const metadata: Metadata = { title: "GitHub App · Admin · RepoPulse" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminGitHubAppPage({ searchParams }: { searchParams: SearchParams }) {
  const admin = await requireSuperAdmin();
  const [app, params] = await Promise.all([getGitHubAppView(admin.githubLogin), searchParams]);
  const created = first(params.created) === "1";
  const error = callbackErrorMessage(first(params.error));
  const appBaseUrl = resolveAppBaseUrl().replace(/\/+$/, "");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">GitHub App</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The RepoPulse GitHub App lets Dependencies open update pull requests as a bot, with short-lived tokens limited to one repository,
          and read private repositories. Members install it on their own repositories.
        </p>
      </div>

      {created && app.configured ? (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-300">
          <CheckCircle2Icon className="mt-px size-4 shrink-0" aria-hidden />
          <span>The GitHub App was created and saved. Members can now install it from their dependency projects.</span>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <TriangleAlertIcon className="mt-px size-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      ) : null}

      <GitHubAppStatusCard app={app} />
      {app.configured ? <GitHubAppWebhooksCard app={app} target={githubAppWebhookTarget(appBaseUrl)} /> : null}
      <CreateGitHubAppForm appBaseUrl={appBaseUrl} replaces={app.configured} />
      <ManualGitHubAppForm app={app} />
      {app.configured || app.keySaved ? <RemoveGitHubAppButton /> : null}

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          The private key and the webhook secret are encrypted with <code className="text-[11px]">TOKEN_ENCRYPTION_KEY</code> and never sent
          back to the browser. RepoPulse checks each member&apos;s own GitHub permission on a repository before it opens a pull request there.
        </span>
      </p>
    </div>
  );
}
