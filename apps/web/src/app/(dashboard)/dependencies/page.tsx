import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheckIcon, ExternalLinkIcon, GitPullRequestIcon, LockIcon, PlusIcon, SearchXIcon, TriangleAlertIcon } from "lucide-react";
import { MAX_DEPENDENCY_PROJECTS_PER_USER } from "@repopulse/deps/limits";
import { RelativeTime } from "@/components/feed/relative-time";
import { RepoAvatar } from "@/components/feed/repo-avatar";
import { AddDependencyProjectsDialog } from "@/components/dependencies/add-dependency-projects-dialog";
import { CheckNowButton } from "@/components/dependencies/check-now-button";
import { DependencyListToolbar } from "@/components/dependencies/dependency-list-toolbar";
import { DepsDisabledNotice, DepsWorkerMissingNotice, OutdatedCounts } from "@/components/dependencies/deps-notices";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { applyDependencyListFilters, dependencyListHref, dependencyProjectHref, parseDependencyListFilters } from "@/lib/dependency-list-filters";
import { PACKAGE_MANAGER_LABELS, updateModeLabel } from "@/lib/dependency-settings";
import { isDepsEnabled, readDepsWorkerStatus } from "@/server/deps-status";
import { getAddableSubscriptions, getDependencyProjects } from "@/server/queries/dependencies";
import { isGitHubAppConfigured } from "@/server/queries/github-app";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Dependencies · RepoPulse" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * `/dependencies` (Slice 08 §3.7.1): the user's dependency projects with outdated counts, open
 * pull requests, mode and last check. Search and sort live in the URL.
 */
export default async function DependenciesPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const filters = parseDependencyListFilters(query);
  const user = await requireUser();

  if (!(await isDepsEnabled())) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <h1 className="text-xl font-semibold tracking-tight">Dependencies</h1>
        <DepsDisabledNotice />
      </div>
    );
  }

  const [projects, addable, appConfigured, worker] = await Promise.all([
    getDependencyProjects(user.id),
    getAddableSubscriptions(user.id),
    isGitHubAppConfigured(),
    readDepsWorkerStatus(),
  ]);
  const shown = applyDependencyListFilters(projects, filters);
  const remaining = MAX_DEPENDENCY_PROJECTS_PER_USER - projects.length;
  const justInstalled = query.installed === "1";

  const addButton = (
    <AddDependencyProjectsDialog subscriptions={addable} appConfigured={appConfigured} remaining={remaining}>
      <Button size="sm">
        <PlusIcon />
        Add projects
      </Button>
    </AddDependencyProjectsDialog>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dependencies</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Outdated npm, Bun and Python dependencies in your own repositories · {projects.length} of {MAX_DEPENDENCY_PROJECTS_PER_USER} projects
          </p>
        </div>
        {addButton}
      </div>

      {worker.state === "missing" ? <DepsWorkerMissingNotice /> : null}
      {justInstalled ? (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-300/60 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-300">
          <CircleCheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            The RepoPulse GitHub App was installed. Open a project and choose a pull request mode in its settings to get update pull
            requests.
          </span>
        </p>
      ) : null}

      {projects.length > 0 ? <DependencyListToolbar filters={filters} shown={shown.length} total={projects.length} /> : null}

      {projects.length === 0 ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-14 text-center">
          <h2 className="font-medium">No projects yet</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Add your own repositories to see which dependencies are outdated. Tracked repositories can be added in one click.
          </p>
          <div className="mt-5">{addButton}</div>
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-14 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <SearchXIcon className="size-5" />
          </span>
          <h2 className="mt-4 font-medium">
            No projects match <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">{filters.q}</code>
          </h2>
          <Button variant="outline" asChild className="mt-5">
            <Link href={dependencyListHref({ sort: filters.sort })}>Clear search</Link>
          </Button>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {shown.map((project) => {
            const href = dependencyProjectHref(project.fullName, filters);
            const busy = project.scanStatus === "QUEUED" || project.scanStatus === "SCANNING";
            return (
              <li key={project.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <RepoAvatar src={project.avatarUrl} name={project.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={href} className="truncate font-medium hover:underline">
                        {project.fullName}
                      </Link>
                      {project.isPrivate ? <LockIcon className="size-3.5 text-muted-foreground" aria-label="Private repository" /> : null}
                      <a
                        href={`https://github.com/${project.fullName}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`${project.fullName} on GitHub`}
                      >
                        <ExternalLinkIcon className="size-3.5" />
                      </a>
                      {project.tracked ? <Badge variant="secondary">Tracked</Badge> : null}
                      <Badge variant="outline">{updateModeLabel(project.updateMode)}</Badge>
                      {project.packageManagers.map((pm) => (
                        <Badge key={pm} variant="outline" className="font-mono text-[11px] font-normal text-muted-foreground">
                          {PACKAGE_MANAGER_LABELS[pm]}
                        </Badge>
                      ))}
                    </div>
                    <dl className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <dt className="sr-only">Outdated</dt>
                        <dd>
                          {project.lastScannedAt ? <OutdatedCounts counts={project.outdated} /> : <span>Not checked yet</span>}
                        </dd>
                      </div>
                      {project.openPullRequests.length > 0 ? (
                        <div className="flex items-center gap-1">
                          <GitPullRequestIcon className="size-3.5" aria-hidden />
                          <dt className="sr-only">Open pull requests</dt>
                          <dd className="flex flex-wrap gap-1.5">
                            {project.openPullRequests.map((pr) => (
                              <a key={pr.id} href={pr.htmlUrl} target="_blank" rel="noopener noreferrer" className="hover:text-foreground hover:underline">
                                #{pr.number}
                              </a>
                            ))}
                          </dd>
                        </div>
                      ) : null}
                      {project.scanStatus === "ERROR" ? (
                        <div className="flex items-center gap-1 text-amber-700 dark:text-amber-400" title={project.scanError ?? undefined}>
                          <TriangleAlertIcon className="size-3.5" aria-hidden />
                          <dt className="sr-only">Status</dt>
                          <dd>Check failed</dd>
                        </div>
                      ) : busy ? (
                        <div className="flex items-center gap-1">
                          <dt className="sr-only">Status</dt>
                          <dd>{project.scanStatus === "SCANNING" ? "Checking…" : "Check queued"}</dd>
                        </div>
                      ) : project.lastScannedAt ? (
                        <div className="flex items-center gap-1">
                          <dt>Checked</dt>
                          <dd>
                            <RelativeTime date={project.lastScannedAt} />
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                </div>
                <div className="flex items-center gap-2 sm:shrink-0">
                  <CheckNowButton projectId={project.id} fullName={project.fullName} busy={busy} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
