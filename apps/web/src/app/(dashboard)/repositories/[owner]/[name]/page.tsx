import {
  ArrowLeftIcon,
  BellOffIcon,
  ExternalLinkIcon,
  RssIcon,
  StarIcon,
  TriangleExclamationPointIcon,
} from "lucide-react";
import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense, type ReactNode } from "react";

import { RepositoryDependenciesCard } from "@/components/dependencies/repository-dependencies-card";
import { LocalDateTime, RelativeTime } from "@/components/feed/relative-time";
import { RepoAvatar } from "@/components/feed/repo-avatar";
import { ActivityGrid } from "@/components/repositories/activity-grid";
import { ActivityStats } from "@/components/repositories/activity-stats";
import { HistoryStatus } from "@/components/repositories/history-status";
import { PinButton } from "@/components/repositories/pin-button";
import { RemoveSubscriptionButton } from "@/components/repositories/remove-subscription-button";
import { SubscriptionSettingsForm } from "@/components/repositories/subscription-settings-form";
import { SyncRepoButton } from "@/components/repositories/sync-repo-button";
import { TagSettings } from "@/components/repositories/tag-settings";
import { TrackingSettings } from "@/components/repositories/tracking-settings";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ActivitySource } from "@/lib/activity-grid";
import { feedHref } from "@/lib/feed-filters";
import { repoListHrefFrom } from "@/lib/repo-list-filters";
import { toRoute } from "@/lib/route";
import { formatVersionStatus } from "@/lib/version-compare";
import { isDepsEnabled } from "@/server/deps-status";
import { getDependencyProjectForRepository } from "@/server/queries/dependencies";
import { getDashboardData, type SubscriptionVisibility } from "@/server/queries/feed";
import {
  getRepositoryActivity,
  getRepositorySettings,
  parseRepoSegment,
  type RepositorySettings,
} from "@/server/queries/repository-settings";
import { requireUser } from "@/server/session";

const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function isSnoozedUntil(snoozedUntil: Date | null): boolean {
  return snoozedUntil !== null && snoozedUntil.getTime() > Date.now();
}

function canonicalRepositoryHref(fullName: string, rawFrom: string | string[] | undefined): Route {
  const from = Array.isArray(rawFrom) ? rawFrom[0] : rawFrom;
  const [canonicalOwner = "", canonicalName = ""] = fullName.split("/");
  const path = `/repositories/${encodeURIComponent(canonicalOwner)}/${encodeURIComponent(canonicalName)}`;
  return toRoute(from ? `${path}?from=${encodeURIComponent(from)}` : path);
}

function activitySourcesFor(trackMode: RepositorySettings["trackMode"], trackPaths: boolean): ActivitySource[] {
  return [
    ...(trackMode !== "NONE" ? (["RELEASE"] as const) : []),
    ...(trackMode === "TAGS_AND_COMMITS" ? (["TAG"] as const) : []),
    ...(trackPaths ? (["COMMIT"] as const) : []),
  ];
}

export async function generateMetadata({ params }: PageProps<"/repositories/[owner]/[name]">): Promise<Metadata> {
  const { owner, name } = await params;
  const slug = `${parseRepoSegment(owner) ?? owner}/${parseRepoSegment(name) ?? name}`;
  return { title: `${slug} · RepoPulse` };
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-6 rounded-lg border bg-card p-4 sm:p-5"
      aria-labelledby={id ? `${id}-title` : undefined}
    >
      <h2 id={id ? `${id}-title` : undefined} className="font-medium">
        {title}
      </h2>
      {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

async function RepositoryActivityContent({
  userId,
  repositoryId,
  sources,
  tracksReleases,
  subscription,
}: {
  userId: string;
  repositoryId: string;
  sources: ActivitySource[];
  tracksReleases: boolean;
  subscription: SubscriptionVisibility;
}) {
  const activity = await getRepositoryActivity(userId, repositoryId, undefined, subscription);
  return (
    <div className="space-y-5">
      <ActivityStats items={activity.items} />
      <ActivityGrid
        repositoryId={repositoryId}
        items={activity.items}
        sources={sources}
        total={activity.total}
        firstStoredAt={activity.firstStoredAt?.toISOString() ?? null}
        truncated={activity.truncated}
        showHistoryLink={tracksReleases}
      />
    </div>
  );
}

async function RepositoryDependenciesContent({
  userId,
  repositoryId,
  subscriptionId,
  fullName,
}: {
  userId: string;
  repositoryId: string;
  subscriptionId: string;
  fullName: string;
}) {
  const dependencyProject = await getDependencyProjectForRepository(userId, repositoryId);
  return <RepositoryDependenciesCard subscriptionId={subscriptionId} fullName={fullName} project={dependencyProject} />;
}

function ActivitySkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading repository activity">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
      <Skeleton className="h-[106px] w-full max-w-[700px]" />
    </div>
  );
}

function RepositoryHeader({
  settings,
  unread,
  snoozed,
}: {
  settings: RepositorySettings;
  unread: number;
  snoozed: boolean;
}) {
  const { repository: repo } = settings;

  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <RepoAvatar src={repo.avatarUrl} name={repo.name} className="size-12" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-xl font-semibold tracking-tight">{repo.fullName}</h1>
          <a
            href={repo.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground"
            aria-label={`${repo.fullName} on GitHub`}
            title="Open on GitHub"
          >
            <ExternalLinkIcon className="size-4" />
          </a>
        </div>
        <p
          className={
            repo.description ? "mt-1 text-sm text-muted-foreground" : "mt-1 text-sm text-muted-foreground/60 italic"
          }
        >
          {repo.description !== null && repo.description.length > 0 ? repo.description : "No description"}
        </p>
        <dl className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <dt className="sr-only">Stars</dt>
            <StarIcon className="size-3.5" aria-hidden />
            <dd className="tabular-nums">{compactNumber.format(repo.starsCount)}</dd>
          </div>
          {repo.pollStatus === "ERROR" ? (
            <div className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <TriangleExclamationPointIcon className="size-3.5" aria-hidden />
              <dt className="sr-only">Status</dt>
              <dd>Last sync failed</dd>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <dt>Synced</dt>
              <dd>{repo.lastPolledAt ? <RelativeTime date={repo.lastPolledAt} /> : "never"}</dd>
            </div>
          )}
          <div className="flex items-center gap-1">
            <dt>Unread</dt>
            <dd className={unread > 0 ? "font-medium text-unread tabular-nums" : "tabular-nums"}>
              {unread > 0 ? <Link href={feedHref({ repositoryId: repo.id, onlyUnread: true })}>{unread}</Link> : 0}
            </dd>
          </div>
          {settings.currentVersion ? (
            <div className="flex items-center gap-1">
              <dt>Your version</dt>
              <dd>
                <a href="#notifications" className="hover:underline" title="Edit or remove your version">
                  <code className="font-mono text-foreground">{settings.currentVersion}</code>
                  {settings.versionStatus ? ` · ${formatVersionStatus(settings.versionStatus)}` : null}
                </a>
              </dd>
            </div>
          ) : null}
          {snoozed ? (
            <div className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <BellOffIcon className="size-3.5" aria-hidden />
              <dt className="sr-only">Notifications</dt>
              <dd>
                Snoozed until <LocalDateTime date={settings.snoozedUntil!} />
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <PinButton
          subscriptionId={settings.subscriptionId}
          fullName={repo.fullName}
          isPinned={settings.isPinned}
          withLabel
        />
        <SyncRepoButton repositoryId={repo.id} />
        <Button variant="outline" size="sm" asChild>
          <Link href={feedHref({ repositoryId: repo.id })}>
            <RssIcon />
            Open in feed
          </Link>
        </Button>
      </div>
    </header>
  );
}

/**
 * Settings of one tracked repository (Slice 07): header, activity grid, tracking, tags,
 * notifications & feed, history and the danger zone. Addresses the signed-in user's own
 * subscription; anything else is the "Not tracked" page.
 */
export default async function RepositorySettingsPage({
  params,
  searchParams,
}: PageProps<"/repositories/[owner]/[name]">) {
  const [{ owner, name }, query, user] = await Promise.all([params, searchParams, requireUser()]);
  const settings = await getRepositorySettings(user.id, owner, name);
  if (!settings) notFound();

  const { repository: repo } = settings;
  const backHref = repoListHrefFrom(query.from);
  // Canonical casing: /repositories/Vercel/Next.js → /repositories/vercel/next.js.
  if (`${parseRepoSegment(owner)}/${parseRepoSegment(name)}` !== repo.fullName) {
    redirect(canonicalRepositoryHref(repo.fullName, query.from));
  }

  const [dashboard, depsEnabled] = await Promise.all([getDashboardData(user.id), isDepsEnabled()]);
  const unread = dashboard.unreadByRepository.find((r) => r.repositoryId === repo.id)?.unreadCount ?? 0;
  const tracksReleases = settings.trackMode !== "NONE";
  const sources = activitySourcesFor(settings.trackMode, settings.trackPaths);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden />
        Tracked repositories
      </Link>

      <RepositoryHeader settings={settings} unread={unread} snoozed={isSnoozedUntil(settings.snoozedUntil)} />

      {settings.note ? (
        <p className="rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-sm wrap-break-word whitespace-pre-wrap">
          {settings.note}
        </p>
      ) : null}

      <Section
        id="activity"
        title="Activity"
        description="Updates in your feed over the last year, by day in your time zone."
      >
        <Suspense fallback={<ActivitySkeleton />}>
          <RepositoryActivityContent
            userId={user.id}
            repositoryId={repo.id}
            sources={sources}
            tracksReleases={tracksReleases}
            subscription={{
              repositoryId: repo.id,
              includePrereleases: settings.includePrereleases,
              trackMode: settings.trackMode,
              trackPaths: settings.trackPaths,
              tagSlugs: [],
            }}
          />
        </Suspense>
      </Section>

      <Section id="tracking" title="Tracking" description="What shows up in your feed for this repository.">
        <TrackingSettings
          subscriptionId={settings.subscriptionId}
          fullName={repo.fullName}
          trackMode={settings.trackMode}
          trackPaths={settings.trackPaths}
          watchedPaths={settings.watchedPaths}
          includePrereleases={settings.includePrereleases}
        />
      </Section>

      <Section id="tags" title="Tags">
        <TagSettings
          subscriptionId={settings.subscriptionId}
          fullName={repo.fullName}
          assigned={settings.tags}
          allTags={settings.allTags}
          sidebarTags={dashboard.tags}
        />
      </Section>

      <Section
        id="notifications"
        title="Notifications & feed"
        description="Only for you: other people tracking this repository are not affected."
      >
        <SubscriptionSettingsForm
          subscriptionId={settings.subscriptionId}
          fullName={repo.fullName}
          tracksReleases={tracksReleases}
          notificationLevel={settings.notificationLevel}
          snoozedUntil={settings.snoozedUntil?.toISOString() ?? null}
          note={settings.note}
          currentVersion={settings.currentVersion}
          versionStatus={settings.versionStatus}
        />
      </Section>

      {tracksReleases ? (
        <Section
          id="history"
          title="History"
          description="Older releases are imported in the background, as read and without notifications."
        >
          <dl className="text-sm text-muted-foreground">
            <HistoryStatus
              repositoryId={repo.id}
              history={repo.history}
              releaseCount={repo.releaseCount}
              canLoadOlder={
                repo.history.status === "DONE" && repo.history.hasMore && repo.history.target < settings.hardCap
              }
            />
          </dl>
        </Section>
      ) : null}

      {depsEnabled ? (
        <Section
          id="dependencies"
          title="Dependencies"
          description="Outdated dependencies of this repository, if it is yours."
        >
          <Suspense fallback={<Skeleton className="h-20 w-full" />}>
            <RepositoryDependenciesContent
              userId={user.id}
              repositoryId={repo.id}
              subscriptionId={settings.subscriptionId}
              fullName={repo.fullName}
            />
          </Suspense>
        </Section>
      ) : null}

      <section className="rounded-lg border border-destructive/40 p-4 sm:p-5" aria-labelledby="danger-title">
        <h2 id="danger-title" className="font-medium text-destructive">
          Danger zone
        </h2>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Stop tracking {repo.fullName}: its updates leave your feed and its tags and settings are removed.
          </p>
          <RemoveSubscriptionButton
            subscriptionId={settings.subscriptionId}
            fullName={repo.fullName}
            redirectTo={backHref}
            withLabel
          />
        </div>
      </section>
    </div>
  );
}
