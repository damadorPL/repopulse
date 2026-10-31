import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLinkIcon, PlusIcon, StarIcon, TriangleAlertIcon } from "lucide-react";
import { RelativeTime } from "@/components/feed/relative-time";
import { RepoAvatar } from "@/components/feed/repo-avatar";
import { SemverBadge } from "@/components/feed/semver-badge";
import { TagPill } from "@/components/feed/tag-pill";
import { AddRepoModal } from "@/components/modals/add-repo-modal";
import { readBackfillConfig } from "@repopulse/queue";
import { AssignTagsPopover } from "@/components/repositories/assign-tags-popover";
import { HistoryStatus } from "@/components/repositories/history-status";
import { RemoveSubscriptionButton } from "@/components/repositories/remove-subscription-button";
import { SyncRepoButton } from "@/components/repositories/sync-repo-button";
import { Button } from "@/components/ui/button";
import { feedHref } from "@/lib/feed-filters";
import { getDashboardData, getTrackedRepositories } from "@/server/queries/feed";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Tracked repositories · RepoPulse" };

const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export default async function RepositoriesPage() {
  const user = await requireUser();
  const [repositories, dashboard] = await Promise.all([getTrackedRepositories(user.id), getDashboardData(user.id)]);
  const unreadByRepo = new Map(dashboard.unreadByRepository.map((r) => [r.repositoryId, r.unreadCount]));
  const allTags = dashboard.tags.map(({ id, name, slug, colorHex }) => ({ id, name, slug, colorHex }));
  const { hardCap } = readBackfillConfig();

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Tracked repositories</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repositories.length} repositor{repositories.length === 1 ? "y" : "ies"} · assign tags to organize your feed
          </p>
        </div>
        <AddRepoModal tags={allTags}>
          <Button size="sm">
            <PlusIcon />
            Add repository
          </Button>
        </AddRepoModal>
      </div>

      {repositories.length === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-14 text-center">
          <h2 className="font-medium">No repositories yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">Add one with the button above to start building your release feed.</p>
        </div>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {repositories.map((entry) => {
            const { repository: repo, latestRelease } = entry;
            const unread = unreadByRepo.get(repo.id) ?? 0;
            return (
              <li key={entry.subscriptionId} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
                <div className="flex items-start gap-3">
                  <RepoAvatar src={repo.avatarUrl} name={repo.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link href={feedHref({ repositoryId: repo.id })} className="truncate font-medium hover:underline">
                        {repo.fullName}
                      </Link>
                      <a
                        href={repo.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`${repo.fullName} on GitHub`}
                      >
                        <ExternalLinkIcon className="size-3.5" />
                      </a>
                    </div>
                    {repo.description ? (
                      <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{repo.description}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    <SyncRepoButton repositoryId={repo.id} iconOnly label={`Sync ${repo.fullName} now`} />
                    <RemoveSubscriptionButton subscriptionId={entry.subscriptionId} fullName={repo.fullName} />
                  </div>
                </div>

                <dl className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <dt className="sr-only">Stars</dt>
                    <StarIcon className="size-3.5" aria-hidden />
                    <dd className="tabular-nums">{compactNumber.format(repo.starsCount)}</dd>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <dt>Latest</dt>
                    <dd className="flex items-center gap-1.5">
                      {latestRelease ? (
                        <>
                          <Link
                            href={feedHref({ repositoryId: repo.id }, latestRelease.id)}
                            className="font-mono text-foreground hover:underline"
                          >
                            {latestRelease.tagName}
                          </Link>
                          <SemverBadge type={latestRelease.semverType} />
                        </>
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center gap-1">
                    <dt>Unread</dt>
                    <dd className={unread > 0 ? "font-medium text-unread tabular-nums" : "tabular-nums"}>
                      {unread > 0 ? <Link href={feedHref({ repositoryId: repo.id, onlyUnread: true })}>{unread}</Link> : 0}
                    </dd>
                  </div>
                  <div className="flex items-center gap-1">
                    <dt>Synced</dt>
                    <dd>{repo.lastPolledAt ? <RelativeTime date={repo.lastPolledAt} /> : "never"}</dd>
                  </div>
                  {repo.pollStatus === "ERROR" ? (
                    <div className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
                      <TriangleAlertIcon className="size-3.5" aria-hidden />
                      <dt className="sr-only">Status</dt>
                      <dd>Last sync failed</dd>
                    </div>
                  ) : null}
                  <HistoryStatus
                    repositoryId={repo.id}
                    history={repo.history}
                    releaseCount={repo.releaseCount}
                    canLoadOlder={repo.history.status === "DONE" && repo.history.hasMore && repo.history.target < hardCap}
                  />
                  {entry.includePrereleases ? (
                    <div>
                      <dt className="sr-only">Pre-releases</dt>
                      <dd>Includes pre-releases</dd>
                    </div>
                  ) : null}
                </dl>

                <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t pt-3">
                  {entry.tags.map((tag) => (
                    <Link key={tag.id} href={feedHref({ tagSlug: tag.slug })} className="rounded-full hover:opacity-80">
                      <TagPill name={tag.name} colorHex={tag.colorHex} />
                    </Link>
                  ))}
                  <AssignTagsPopover
                    subscriptionId={entry.subscriptionId}
                    repositoryName={repo.fullName}
                    allTags={allTags}
                    assignedTagIds={entry.tags.map((t) => t.id)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
