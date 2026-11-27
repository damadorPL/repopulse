import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { InboxIcon, PlusIcon, SearchXIcon } from "lucide-react";
import { FeedFilterBar } from "@/components/feed/feed-filter-bar";
import { ReleaseFeedList } from "@/components/feed/release-feed-list";
import { TagDot } from "@/components/feed/tag-pill";
import { AddRepoModal } from "@/components/modals/add-repo-modal";
import { ChangelogDrawer } from "@/components/reader/changelog-drawer";
import { ChangelogMarkdown } from "@/components/reader/changelog-markdown";
import { ReaderProvider } from "@/components/reader/reader-context";
import { Button } from "@/components/ui/button";
import { feedFiltersKey, feedHref, parseFeedFilters, parseReleaseParam } from "@/lib/feed-filters";
import {
  countUnread,
  getDashboardData,
  getReleaseDetail,
  getReleaseFeed,
  getUserFeedContext,
  type FeedItem,
  type ReleaseDetail,
} from "@/server/queries/feed";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Releases · RepoPulse" };

export default async function ReleaseFeedPage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const filters = parseFeedFilters(params);
  const releaseId = parseReleaseParam(params);
  const user = await requireUser();

  const [context, detail] = await Promise.all([
    getUserFeedContext(user.id),
    releaseId ? getReleaseDetail(user.id, releaseId) : Promise.resolve(null),
  ]);

  const tag = filters.tagSlug ? (context.tags.find((t) => t.slug === filters.tagSlug) ?? null) : null;
  const repository = filters.repositoryId
    ? (context.subscriptions.find((s) => s.repositoryId === filters.repositoryId) ?? null)
    : null;

  const heading = tag?.name ?? repository?.fullName ?? (filters.onlyUnread ? "Unread releases" : "All releases");
  const filtered = Boolean(filters.semverType || filters.searchQuery);
  const needsExactUnreadCount = filtered || Boolean(filters.tagSlug && filters.repositoryId);
  const [page, viewUnread] = await Promise.all([
    getReleaseFeed({
      userId: user.id,
      ...filters,
      subscriptions: context.subscriptionVisibility,
      repoContextById: context.repoContextById,
    }),
    needsExactUnreadCount
      ? countUnread(user.id, filters, context.subscriptionVisibility)
      : !tag && !repository && (filters.tagSlug || filters.repositoryId)
        ? Promise.resolve(0) // unknown tag / untracked repo
        : getDashboardData(user.id).then((dashboard) =>
            tag
              ? (dashboard.tags.find((t) => t.id === tag.id)?.unreadCount ?? 0)
              : repository
                ? (dashboard.unreadByRepository.find((r) => r.repositoryId === repository.repositoryId)?.unreadCount ??
                  0)
                : dashboard.totalUnread,
          ),
  ]);
  const key = feedFiltersKey(filters);
  const drawerItem = detail ? toDrawerItem(detail) : null;

  return (
    <ReaderProvider initialDetail={drawerItem}>
      <div className="mx-auto max-w-4xl space-y-5">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">
            {tag ? <TagDot color={tag.colorHex} className="size-3" /> : null}
            {heading}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {viewUnread > 0 ? `${viewUnread} unread` : "All caught up"}
            {context.subscriptions.length > 0
              ? ` · ${context.subscriptions.length} tracked repositor${context.subscriptions.length === 1 ? "y" : "ies"}`
              : null}
          </p>
        </div>

        <FeedFilterBar
          filters={filters}
          tag={tag}
          repositoryName={repository?.fullName ?? null}
          unreadInView={viewUnread > 0}
        />

        <ReleaseFeedList
          key={key}
          initialPage={page}
          query={key}
          emptyState={
            context.subscriptions.length === 0 ? (
              <EmptyState
                icon={<PlusIcon />}
                title="Track your first repository"
                description="Add a GitHub repository and its latest releases show up here, with changelogs and SemVer badges."
                action={
                  <AddRepoModal
                    tags={context.tags.map(({ id, name, slug, colorHex }) => ({ id, name, slug, colorHex }))}
                  >
                    <Button>
                      <PlusIcon />
                      Add repository
                    </Button>
                  </AddRepoModal>
                }
              />
            ) : filters.onlyUnread && !filtered && !tag && !repository ? (
              <EmptyState
                icon={<InboxIcon />}
                title="Inbox zero"
                description="No unread releases. New ones appear here as they are published."
              />
            ) : (
              <EmptyState
                icon={<SearchXIcon />}
                title="No releases match"
                description="Try another filter, or clear them to see everything."
                action={
                  <Button variant="outline" asChild>
                    <Link href={feedHref()}>Clear filters</Link>
                  </Button>
                }
              />
            )
          }
        />
      </div>

      {/* Only the rendered markdown crosses to the client; the raw body stays on the server. */}
      <ChangelogDrawer detail={drawerItem}>
        {detail ? <ChangelogMarkdown markdown={detail.bodyMarkdown} /> : null}
      </ChangelogDrawer>
    </ReaderProvider>
  );
}

function toDrawerItem({ bodyMarkdown: _body, repositoryLastPolledAt: _polled, ...item }: ReleaseDetail): FeedItem {
  return item;
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-14 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
        {icon}
      </span>
      <h2 className="mt-4 font-medium">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
