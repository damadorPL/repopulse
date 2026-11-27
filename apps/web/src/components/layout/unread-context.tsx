"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { SidebarTag, UnreadByRepository } from "@/server/queries/feed";

export interface UnreadSnapshot {
  tags: SidebarTag[];
  totalUnread: number;
  unreadByRepository: UnreadByRepository[];
}

export interface UnreadTarget {
  repository: { id: string; fullName: string; avatarUrl: string | null };
  tags: ReadonlyArray<{ id: string }>;
}

interface UnreadContextValue extends UnreadSnapshot {
  adjustUnread: (item: UnreadTarget, delta: 1 | -1) => void;
}

const UnreadContext = createContext<UnreadContextValue | null>(null);

export function UnreadProvider({
  tags,
  totalUnread,
  unreadByRepository,
  children,
}: UnreadSnapshot & { children: ReactNode }) {
  const serverSource = { tags, totalUnread, unreadByRepository };
  const [prevSource, setPrevSource] = useState(serverSource);
  const [state, setState] = useState<UnreadSnapshot>(serverSource);

  // Resync whenever server props update (after navigation, router.refresh(), or markAllRead).
  if (
    prevSource.tags !== tags ||
    prevSource.totalUnread !== totalUnread ||
    prevSource.unreadByRepository !== unreadByRepository
  ) {
    setPrevSource(serverSource);
    setState(serverSource);
  }

  function adjustUnread(item: UnreadTarget, delta: 1 | -1) {
    const tagIds = new Set(item.tags.map((t) => t.id));
    setState((current) => {
      const nextTotal = Math.max(0, current.totalUnread + delta);
      const nextTags =
        tagIds.size === 0
          ? current.tags
          : current.tags.map((tag) =>
              tagIds.has(tag.id) ? { ...tag, unreadCount: Math.max(0, tag.unreadCount + delta) } : tag,
            );

      const repoIndex = current.unreadByRepository.findIndex((r) => r.repositoryId === item.repository.id);
      let nextRepos: UnreadByRepository[];
      if (repoIndex === -1) {
        if (delta <= 0) {
          nextRepos = current.unreadByRepository;
        } else {
          nextRepos = [
            ...current.unreadByRepository,
            {
              repositoryId: item.repository.id,
              fullName: item.repository.fullName,
              avatarUrl: item.repository.avatarUrl,
              unreadCount: 1,
            },
          ].sort((a, b) => b.unreadCount - a.unreadCount || a.fullName.localeCompare(b.fullName));
        }
      } else {
        const existing = current.unreadByRepository[repoIndex]!;
        const updatedCount = existing.unreadCount + delta;
        if (updatedCount <= 0) {
          nextRepos = current.unreadByRepository.filter((_, idx) => idx !== repoIndex);
        } else {
          nextRepos = current.unreadByRepository
            .map((entry, idx) => (idx === repoIndex ? { ...entry, unreadCount: updatedCount } : entry))
            .sort((a, b) => b.unreadCount - a.unreadCount || a.fullName.localeCompare(b.fullName));
        }
      }

      return { tags: nextTags, totalUnread: nextTotal, unreadByRepository: nextRepos };
    });
  }

  return <UnreadContext value={{ ...state, adjustUnread }}>{children}</UnreadContext>;
}

export function useOptionalUnread(): UnreadContextValue | null {
  return useContext(UnreadContext);
}
