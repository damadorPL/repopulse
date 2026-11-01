import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRightIcon, HistoryIcon, MailIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { prisma } from "@repopulse/db";
import { getBackfillSettingsView } from "@/server/backfill-settings";
import { getInvites, getMemberCount } from "@/server/queries/access";
import { isPublicRegistrationOpen } from "@/server/registration";
import { requireSuperAdmin } from "@/server/session";
import { getSmtpSettingsView } from "@/server/smtp-settings";

export const metadata: Metadata = { title: "Admin · RepoPulse" };

const numberFormat = new Intl.NumberFormat("en");

function SectionCard({
  href,
  icon: Icon,
  title,
  status,
  details,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  status: string;
  details: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="group flex h-full items-start gap-3 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="font-medium">{title}</span>
          <span className="text-sm">{status}</span>
          <span className="text-xs text-muted-foreground">{details}</span>
        </span>
        <ChevronRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  );
}

export default async function AdminOverviewPage() {
  await requireSuperAdmin();

  const [publicRegistration, invites, memberCount, smtp, history, repositoryCount] = await Promise.all([
    isPublicRegistrationOpen(),
    getInvites(),
    getMemberCount(),
    getSmtpSettingsView(),
    getBackfillSettingsView(),
    prisma.repository.count({ where: { subscriptions: { some: {} } } }),
  ]);
  const pendingInvites = invites.filter((invite) => invite.status === "pending").length;
  const value = (key: string) => history.find((s) => s.key === key)!.value;
  const customCount = history.filter((s) => s.source === "admin").length;
  const maxAge = value("maxAgeDays");

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          { label: "Members", value: memberCount },
          { label: "Tracked repositories", value: repositoryCount },
          { label: "Pending invites", value: pendingInvites },
        ].map((stat) => (
          <div key={stat.label} className="rounded-lg border bg-card px-4 py-3">
            <dt className="text-xs text-muted-foreground">{stat.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{numberFormat.format(stat.value)}</dd>
          </div>
        ))}
      </dl>

      <ul className="grid gap-3 sm:grid-cols-2">
        <SectionCard
          href="/admin/access"
          icon={UsersIcon}
          title="Access"
          status={publicRegistration ? "Public registration is on" : "Invite-only"}
          details="Who can create an account, and invite links."
        />
        <SectionCard
          href="/admin/email"
          icon={MailIcon}
          title="Email (SMTP)"
          status={smtp.enabled ? `Sending through ${smtp.host}:${smtp.port}` : "Not set up: email notifications are off"}
          details="The SMTP server email notifications go through."
        />
        <SectionCard
          href="/admin/history"
          icon={HistoryIcon}
          title="Release history"
          status={`${numberFormat.format(value("defaultTarget"))} releases on add${maxAge > 0 ? `, up to ${numberFormat.format(maxAge)} days back` : ""} · cap ${numberFormat.format(value("hardCap"))}`}
          details={
            customCount > 0
              ? `${customCount} custom ${customCount === 1 ? "setting" : "settings"}; the rest from the environment or defaults.`
              : "From the environment or defaults; nothing customized yet."
          }
        />
      </ul>

      <p className="text-xs text-muted-foreground tabular-nums">RepoPulse v{process.env.APP_VERSION}</p>
    </div>
  );
}
