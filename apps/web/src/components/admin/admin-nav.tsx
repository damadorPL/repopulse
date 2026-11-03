"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BotIcon, HistoryIcon, LayoutDashboardIcon, MailIcon, PackageIcon, UsersIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** The sections of the admin panel (super admin only). */
export const ADMIN_SECTIONS = [
  { href: "/admin", label: "Overview", icon: LayoutDashboardIcon, exact: true },
  { href: "/admin/access", label: "Access", icon: UsersIcon, exact: false },
  { href: "/admin/email", label: "Email (SMTP)", icon: MailIcon, exact: false },
  { href: "/admin/history", label: "Release history", icon: HistoryIcon, exact: false },
  { href: "/admin/github-app", label: "GitHub App", icon: BotIcon, exact: false },
  { href: "/admin/dependencies", label: "Dependencies", icon: PackageIcon, exact: false },
] as const;

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin sections" className="-mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b px-1">
        {ADMIN_SECTIONS.map(({ href, label, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
                  active
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
