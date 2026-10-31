import type { ReactNode } from "react";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { TopNavbar } from "@/components/layout/top-navbar";
import { SseListener } from "@/components/realtime/sse-listener";
import { getDashboardData } from "@/server/queries/feed";
import { requireUser } from "@/server/session";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const data = await getDashboardData(user.id);

  const sidebar = (
    <AppSidebar tags={data.tags} totalUnread={data.totalUnread} repositoryCount={data.subscriptions.length} />
  );

  return (
    <div className="flex min-h-dvh">
      <SseListener />
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-sidebar-border bg-sidebar md:block">{sidebar}</aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopNavbar
          user={{ name: user.name, email: user.email, avatarUrl: user.avatarUrl }}
          tags={data.tags}
          totalUnread={data.totalUnread}
          unreadByRepository={data.unreadByRepository}
          sidebar={sidebar}
        />
        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
