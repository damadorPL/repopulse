import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeftIcon, BellOffIcon, ExternalLinkIcon, RssIcon, StarIcon, TriangleAlertIcon } from "lucide-react";
import { LocalDateTime, RelativeTime } from "@/components/feed/relative-time";
import { RepoAvatar } from "@/components/feed/repo-avatar";
import { RepositoryDependenciesCard } from "@/components/dependencies/repository-dependencies-card";
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
import type { ActivitySource } from "@/lib/activity-grid";
import { feedHref } from "@/lib/feed-filters";
import { repoListHrefFrom } from "@/lib/repo-list-filters";
import { formatVersionStatus } from "@/lib/version-compare";
import { isDepsEnabled } from "@/server/deps-status";
import { getDependencyProjectForRepository } from "@/server/queries/dependencies";
import { getDashboardData } from "@/server/queries/feed";
import { getRepositoryActivity, getRepositorySettings, parseRepoSegment } from "@/server/queries/repository-settings";
import { requireUser } from "@/server/session";

type Params = Promise<{ owner: string; name: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { owner, name } = await params;
  const slug = `${parseRepoSegment(owner) ?? owner}/${parseRepoSegment(name) ?? name}`;
  return { title: `${slug} · RepoPulse` };
}

function Section({ id, title, description, children }: { id?: string; title: string; description?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-lg border bg-card p-4 sm:p-5" aria-labelledby={id ? `${id}-title` : undefined}>
      <h2 id={id ? `${id}-title` : undefined} className="font-medium">
        {title}
      </h2>
      {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * Settings of one tracked repository (Slice 07): header, activity grid, tracking, tags,
 * notifications & feed, history and the danger zone. Addresses the signed-in user's own
 * subscription; anything else is the "Not tracked" page.
 */
export default async function RepositorySettingsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ owner, name }, query] = await Promise.all([params, searchParams]);
  const user = await requireUser();
  const settings = await getRepositorySettings(user.id, owner, name);
  if (!settings) notFound();

  const { repository: repo } = settings;
  const backHref = repoListHrefFrom(query.from);
  // Canonical casing: /repositories/Vercel/Next.js → /repositories/vercel/next.js.
  if (`${parseRepoSegment(owner)}/${parseRepoSegment(name)}` !== repo.fullName) {
    const from = Array.isArray(query.from) ? query.from[0] : query.from;
    const [canonicalOwner = "", canonicalName = ""] = repo.fullName.split("/");
    const path = `/repositories/${encodeURIComponent(canonicalOwner)}/${encodeURIComponent(canonicalName)}`;
    redirect(from ? `${path}?from=${encodeURIComponent(from)}` : path);
  }

  const [activity, dashboard, depsEnabled] = await Promise.all([getRepositoryActivity(user.id, repo.id), getDashboardData(user.id), isDepsEnabled()]);
  // Slice 08: the "Dependencies" card, only while the module is on.
  const dependencyProject = depsEnabled ? await getDependencyProjectForRepository(user.id, repo.id) : null;
  const unread = dashboard.unreadByRepository.find((r) => r.repositoryId === repo.id)?.unreadCount ?? 0;
  const tracksReleases = settings.trackMode !== "NONE";
  const sources: ActivitySource[] = [
    ...(tracksReleases ? (["RELEASE"] as const) : []),
    ...(settings.trackMode === "TAGS_AND_COMMITS" ? (["TAG"] as const) : []),
    ...(settings.trackPaths ? (["COMMIT"] as const) : []),
  ];
  const snoozed = settings.snoozedUntil !== null && settings.snoozedUntil.getTime() > Date.now();

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon className="size-4" aria-hidden />
        Tracked repositories
      </Link>

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
          <p className={repo.description ? "mt-1 text-sm text-muted-foreground" : "mt-1 text-sm text-muted-foreground/60 italic"}>
            {repo.description || "No description"}
          </p>
          <dl className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <div className="flex items-center gap-1">
              <dt className="sr-only">Stars</dt>
              <StarIcon className="size-3.5" aria-hidden />
              <dd className="tabular-nums">{compactNumber.format(repo.starsCount)}</dd>
            </div>
            {repo.pollStatus === "ERROR" ? (
              <div className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
                <TriangleAlertIcon className="size-3.5" aria-hidden />
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
                  <code className="font-mono text-foreground">{settings.currentVersion}</code>
                  {settings.versionStatus ? ` · ${formatVersionStatus(settings.versionStatus)}` : null}
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
          <PinButton subscriptionId={settings.subscriptionId} fullName={repo.fullName} isPinned={settings.isPinned} withLabel />
          <SyncRepoButton repositoryId={repo.id} />
          <Button variant="outline" size="sm" asChild>
            <Link href={feedHref({ repositoryId: repo.id })}>
              <RssIcon />
              Open in feed
            </Link>
          </Button>
        </div>
      </header>

      {settings.note ? (
        <p className="rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-sm whitespace-pre-wrap break-words">{settings.note}</p>
      ) : null}

      <Section id="activity" title="Activity" description="Updates in your feed over the last year, by day in your time zone.">
        <div className="space-y-5">
          <ActivityStats items={activity.items} />
          <ActivityGrid
            repositoryId={repo.id}
            items={activity.items}
            sources={sources}
            total={activity.total}
            firstStoredAt={activity.firstStoredAt?.toISOString() ?? null}
            truncated={activity.truncated}
            showHistoryLink={tracksReleases}
          />
        </div>
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

      <Section id="notifications" title="Notifications & feed" description="Only for you: other people tracking this repository are not affected.">
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
        <Section id="history" title="History" description="Older releases are imported in the background, as read and without notifications.">
          <dl className="text-sm text-muted-foreground">
            <HistoryStatus
              repositoryId={repo.id}
              history={repo.history}
              releaseCount={repo.releaseCount}
              canLoadOlder={repo.history.status === "DONE" && repo.history.hasMore && repo.history.target < settings.hardCap}
            />
          </dl>
        </Section>
      ) : null}

      {depsEnabled ? (
        <Section id="dependencies" title="Dependencies" description="Outdated dependencies of this repository, if it is yours.">
          <RepositoryDependenciesCard subscriptionId={settings.subscriptionId} fullName={repo.fullName} project={dependencyProject} />
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
          <RemoveSubscriptionButton subscriptionId={settings.subscriptionId} fullName={repo.fullName} redirectTo={backHref} withLabel />
        </div>
      </section>
    </div>
  );
}
