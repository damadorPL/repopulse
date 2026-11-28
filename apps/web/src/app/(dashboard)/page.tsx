import { InboxIcon, PlusIcon, SearchXIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { FeedFilterBar } from "@/components/feed/feed-filter-bar";
import { ReleaseFeedList } from "@/components/feed/release-feed-list";
import { TagDot } from "@/components/feed/tag-pill";
import { AddRepoModal } from "@/components/modals/add-repo-modal";
import { ChangelogDrawer } from "@/components/reader/changelog-drawer";
import { ChangelogMarkdown } from "@/components/reader/changelog-markdown";
import { ReaderProvider } from "@/components/reader/reader-context";
import { Button } from "@/components/ui/button";
import { feedFiltersKey, feedHref, parseFeedFilters, parseReleaseParam, type FeedFilters } from "@/lib/feed-filters";
import {
  countUnread,
  getDashboardData,
  getReleaseDetail,
  getReleaseFeed,
  getUserFeedContext,
  type FeedItem,
  type ReleaseDetail,
  type TagPill,
  type UserFeedContext,
} from "@/server/queries/feed";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Releases · RepoPulse" };

async function resolveViewUnreadCount(
  userId: string,
  filters: FeedFilters,
  context: UserFeedContext,
  tag: UserFeedContext["tags"][number] | null,
  repository: UserFeedContext["subscriptions"][number] | null,
): Promise<number> {
  const filtered = Boolean(filters.semverType || filters.searchQuery);
  if (filtered || Boolean(filters.tagSlug && filters.repositoryId)) {
    return countUnread(userId, filters, context.subscriptionVisibility);
  }
  if (!tag && !repository && (filters.tagSlug || filters.repositoryId)) {
    return 0; // unknown tag / untracked repo
  }
  const dashboard = await getDashboardData(userId);
  if (tag) return dashboard.tags.find((t) => t.id === tag.id)?.unreadCount ?? 0;
  if (repository) {
    return dashboard.unreadByRepository.find((r) => r.repositoryId === repository.repositoryId)?.unreadCount ?? 0;
  }
  return dashboard.totalUnread;
}

function feedHeading(
  tag: { name: string } | null,
  repository: { fullName: string } | null,
  onlyUnread: boolean,
): string {
  if (tag) return tag.name;
  if (repository) return repository.fullName;
  return onlyUnread ? "Unread releases" : "All releases";
}

function feedSubtitle(viewUnread: number, repoCount: number): string {
  const unreadText = viewUnread > 0 ? `${viewUnread} unread` : "All caught up";
  if (repoCount === 0) return unreadText;
  return `${unreadText} · ${repoCount} tracked repositor${repoCount === 1 ? "y" : "ies"}`;
}

function FeedEmptyState({
  hasSubscriptions,
  onlyUnread,
  filtered,
  hasScope,
  tags,
}: {
  hasSubscriptions: boolean;
  onlyUnread: boolean;
  filtered: boolean;
  hasScope: boolean;
  tags: TagPill[];
}) {
  if (!hasSubscriptions) {
    return (
      <EmptyState
        icon={<PlusIcon />}
        title="Track your first repository"
        description="Add a GitHub repository and its latest releases show up here, with changelogs and SemVer badges."
        action={
          <AddRepoModal tags={tags}>
            <Button>
              <PlusIcon />
              Add repository
            </Button>
          </AddRepoModal>
        }
      />
    );
  }
  if (onlyUnread && !filtered && !hasScope) {
    return (
      <EmptyState
        icon={<InboxIcon />}
        title="Inbox zero"
        description="No unread releases. New ones appear here as they are published."
      />
    );
  }
  return (
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
  );
}

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

  const heading = feedHeading(tag, repository, filters.onlyUnread);
  const filtered = Boolean(filters.semverType || filters.searchQuery);
  const [page, viewUnread] = await Promise.all([
    getReleaseFeed({
      userId: user.id,
      ...filters,
      subscriptions: context.subscriptionVisibility,
      repoContextById: context.repoContextById,
    }),
    resolveViewUnreadCount(user.id, filters, context, tag, repository),
  ]);
  const key = feedFiltersKey(filters);
  const drawerItem = detail ? toDrawerItem(detail) : null;

  return (
    <Suspense fallback={null}>
      <ReaderProvider initialDetail={drawerItem}>
        <div className="mx-auto max-w-4xl space-y-5">
          <div>
            <h1 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">
              {tag ? <TagDot color={tag.colorHex} className="size-3" /> : null}
              {heading}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {feedSubtitle(viewUnread, context.subscriptions.length)}
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
              <FeedEmptyState
                hasSubscriptions={context.subscriptions.length > 0}
                onlyUnread={filters.onlyUnread}
                filtered={filtered}
                hasScope={Boolean(tag || repository)}
                tags={context.tags.map(({ id, name, slug, colorHex }) => ({ id, name, slug, colorHex }))}
              />
            }
          />
        </div>

        {/* Only the rendered markdown crosses to the client; the raw body stays on the server. */}
        <ChangelogDrawer detail={drawerItem}>
          {detail ? <ChangelogMarkdown markdown={detail.bodyMarkdown} /> : null}
        </ChangelogDrawer>
      </ReaderProvider>
    </Suspense>
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
