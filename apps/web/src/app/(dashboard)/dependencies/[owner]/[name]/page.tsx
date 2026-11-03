import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeftIcon, ExternalLinkIcon, GitBranchIcon, LockIcon, TriangleAlertIcon } from "lucide-react";
import { RelativeTime } from "@/components/feed/relative-time";
import { RepoAvatar } from "@/components/feed/repo-avatar";
import { AppStatusBanner } from "@/components/dependencies/app-status-banner";
import { CheckNowButton } from "@/components/dependencies/check-now-button";
import { DependencySettingsForm, IgnoreRulesEditor } from "@/components/dependencies/dependency-settings-form";
import { DepsDisabledNotice, DepsWorkerMissingNotice, OutdatedCounts } from "@/components/dependencies/deps-notices";
import { OutdatedTable } from "@/components/dependencies/outdated-table";
import { PullRequestsSection } from "@/components/dependencies/pull-requests-section";
import { RemoveProjectButton } from "@/components/dependencies/remove-project-button";
import { Badge } from "@/components/ui/badge";
import { dependencyListHrefFrom } from "@/lib/dependency-list-filters";
import { PACKAGE_MANAGER_LABELS, updateModeLabel, type LevelCounts } from "@/lib/dependency-settings";
import { repositorySettingsHref } from "@/lib/repo-list-filters";
import { getGitHubToken } from "@/server/action-result";
import { isDepsEnabled, lockfileRegenerationAvailable, readDepsWorkerStatus } from "@/server/deps-status";
import { getAppRepoStatus, getDependencyProject, planPullRequests, type AppRepoStatus, type PrOwnerView } from "@/server/queries/dependencies";
import { parseRepoSegment } from "@/server/queries/repository-settings";
import { requireUser } from "@/server/session";

type Params = Promise<{ owner: string; name: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { owner, name } = await params;
  const slug = `${parseRepoSegment(owner) ?? owner}/${parseRepoSegment(name) ?? name}`;
  return { title: `${slug} · Dependencies · RepoPulse` };
}

function Section({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-lg border bg-card p-4 sm:p-5" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="font-medium">
        {title}
      </h2>
      {description ? <div className="mt-0.5 text-sm text-muted-foreground">{description}</div> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Why the PR modes can't be chosen in Settings, or `null` (the action re-checks installation and write access). */
function prModeReason(app: AppRepoStatus, prOwner: PrOwnerView): string | null {
  if (prOwner.kind === "other") return `PRs are managed by another RepoPulse user (${prOwner.ownerName}).`;
  if (app.state === "not_configured") return "the administrator has not set up the RepoPulse GitHub App.";
  if (app.state === "not_installed") return "install the GitHub App first.";
  return null;
}

/**
 * A dependency project (Slice 08 §3.7.3): header with the App status, outdated table, planned and
 * past pull requests, settings, detected manifests and the danger zone. Only the signed-in user's
 * own project; anything else is `notFound()`.
 */
export default async function DependencyProjectPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ owner, name }, query] = await Promise.all([params, searchParams]);
  const user = await requireUser();
  const backHref = dependencyListHrefFrom(query.from);

  if (!(await isDepsEnabled())) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <Link href="/dependencies" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon className="size-4" aria-hidden />
          Dependencies
        </Link>
        <DepsDisabledNotice />
      </div>
    );
  }

  const project = await getDependencyProject(user.id, owner, name);
  if (!project) notFound();

  // Canonical casing: /dependencies/Vercel/Next.js → /dependencies/vercel/next.js.
  if (`${parseRepoSegment(owner)}/${parseRepoSegment(name)}` !== project.fullName) {
    const from = Array.isArray(query.from) ? query.from[0] : query.from;
    const [canonicalOwner = "", canonicalName = ""] = project.fullName.split("/");
    const path = `/dependencies/${encodeURIComponent(canonicalOwner)}/${encodeURIComponent(canonicalName)}`;
    redirect(from ? `${path}?from=${encodeURIComponent(from)}` : path);
  }

  const [app, worker] = await Promise.all([
    getAppRepoStatus(project.owner, project.name, project.githubRepoId, getGitHubToken(user, "DependencyProjectPage")),
    readDepsWorkerStatus(),
  ]);
  const plans = planPullRequests(project, app, { lockfileRegeneration: lockfileRegenerationAvailable(worker) });
  const outdated: LevelCounts = { major: 0, minor: 0, patch: 0, other: 0 };
  for (const row of project.updates) {
    if (row.status !== "OUTDATED") continue;
    if (row.level === "MAJOR") outdated.major++;
    else if (row.level === "MINOR") outdated.minor++;
    else if (row.level === "PATCH") outdated.patch++;
    else outdated.other++;
  }
  const busy = project.scanStatus === "QUEUED" || project.scanStatus === "SCANNING";
  const packageManagers = [...new Set(project.manifests.map((m) => m.packageManager))].sort();
  const { ignoreRules, ...settingsValues } = project.settings;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon className="size-4" aria-hidden />
        Dependencies
      </Link>

      <header className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <RepoAvatar src={project.avatarUrl} name={project.name} className="size-12" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{project.fullName}</h1>
            {project.isPrivate ? <LockIcon className="size-4 text-muted-foreground" aria-label="Private repository" /> : null}
            <a
              href={`https://github.com/${project.fullName}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
              aria-label={`${project.fullName} on GitHub`}
              title="Open on GitHub"
            >
              <ExternalLinkIcon className="size-4" />
            </a>
            <Badge variant="outline">{updateModeLabel(project.settings.updateMode)}</Badge>
            {project.tracked ? (
              <Link href={repositorySettingsHref(project.fullName)}>
                <Badge variant="secondary">Tracked</Badge>
              </Link>
            ) : null}
          </div>
          <dl className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <GitBranchIcon className="size-3.5" aria-hidden />
              <dt className="sr-only">Default branch</dt>
              <dd className="font-mono">{project.defaultBranch}</dd>
            </div>
            {packageManagers.length > 0 ? (
              <div className="flex items-center gap-1">
                <dt className="sr-only">Package managers</dt>
                <dd>{packageManagers.map((pm) => PACKAGE_MANAGER_LABELS[pm]).join(", ")}</dd>
              </div>
            ) : null}
            <div className="flex items-center gap-1">
              <dt>{busy ? "Status" : "Checked"}</dt>
              <dd>
                {project.scanStatus === "SCANNING" ? (
                  "Re-checking…"
                ) : project.scanStatus === "QUEUED" ? (
                  "Check queued…"
                ) : project.lastScannedAt ? (
                  <RelativeTime date={project.lastScannedAt} />
                ) : (
                  "never"
                )}
              </dd>
            </div>
            {project.nextScanAt && !busy ? (
              <div className="flex items-center gap-1">
                <dt>Next check</dt>
                <dd>
                  <RelativeTime date={project.nextScanAt} />
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CheckNowButton projectId={project.id} fullName={project.fullName} busy={busy} />
        </div>
      </header>

      {worker.state === "missing" ? <DepsWorkerMissingNotice /> : null}
      {project.scanStatus === "ERROR" ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">The last check failed.</span> {project.scanError ?? "Try “Check now” again later."}
          </span>
        </p>
      ) : null}
      <AppStatusBanner status={app} prOwner={project.prOwner} fullName={project.fullName} />

      <Section
        id="outdated"
        title="Dependencies"
        description={project.lastScannedAt ? <OutdatedCounts counts={outdated} emptyLabel="Everything is up to date under your policy" /> : "Not checked yet: results appear after the first check."}
      >
        <OutdatedTable
          projectId={project.id}
          rows={project.updates}
          manifests={project.manifests}
          minReleaseAgeDays={project.settings.minReleaseAgeDays}
          trackedFullNames={project.trackedFullNames}
        />
      </Section>

      <Section id="pull-requests" title="Pull requests" description="One branch per group, repopulse/deps/<group>. Your repository's CI runs on them.">
        <PullRequestsSection projectId={project.id} plans={plans} history={project.pullRequests} />
      </Section>

      <Section id="settings" title="Settings" description="Only for this project. Policy changes re-check the project.">
        <DependencySettingsForm
          projectId={project.id}
          fullName={project.fullName}
          values={settingsValues}
          prModeReason={prModeReason(app, project.prOwner)}
          detectedManifests={project.manifests.map((m) => m.path)}
        />
        <div className="mt-6 border-t pt-5">
          <h3 className="text-sm font-medium">Ignore rules</h3>
          <p className="mt-0.5 mb-3 text-xs text-muted-foreground">
            Names may start and/or end with <code>*</code> (<code>@types/*</code>). A version range ignores only those versions.
          </p>
          <IgnoreRulesEditor projectId={project.id} rules={ignoreRules} />
        </div>
      </Section>

      <Section id="manifests" title="Manifests" description="Files found on the default branch at the last check.">
        {project.manifests.length === 0 ? (
          <p className="text-sm text-muted-foreground">{project.lastScannedAt ? "No supported manifest was found." : "Not checked yet."}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 font-medium">Path</th>
                  <th className="px-2 py-2 font-medium">Package manager</th>
                  <th className="px-2 py-2 font-medium">Lockfile</th>
                  <th className="px-2 py-2 text-right font-medium">Dependencies</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {project.manifests.map((manifest) => (
                  <tr key={manifest.id} className="align-top">
                    <td className="px-3 py-2">
                      <code className="font-mono text-xs">{manifest.path}</code>
                      {manifest.warnings.map((warning) => (
                        <span key={warning} className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                          <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
                          {warning}
                        </span>
                      ))}
                    </td>
                    <td className="px-2 py-2 text-xs">{PACKAGE_MANAGER_LABELS[manifest.packageManager]}</td>
                    <td className="px-2 py-2">
                      {manifest.lockfilePath ? <code className="font-mono text-xs">{manifest.lockfilePath}</code> : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{manifest.dependencyCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <section className="rounded-lg border border-destructive/40 p-4 sm:p-5" aria-labelledby="danger-title">
        <h2 id="danger-title" className="font-medium text-destructive">
          Danger zone
        </h2>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Stop checking {project.fullName}. RepoPulse stops managing its pull requests; open ones stay on GitHub.
          </p>
          <RemoveProjectButton projectId={project.id} fullName={project.fullName} redirectTo={backHref} />
        </div>
      </section>
    </div>
  );
}
