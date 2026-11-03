import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { BoxIcon, CircleCheckIcon, CircleDashedIcon, CircleXIcon, type LucideIcon } from "lucide-react";
import { DepsEnabledToggle } from "@/components/admin/deps-enabled-toggle";
import { cn } from "@/lib/utils";
import { getDepsAdminView, type DepsWorkerStatus } from "@/server/deps-status";
import { requireSuperAdmin } from "@/server/session";

export const metadata: Metadata = { title: "Dependencies · Admin · RepoPulse" };

const numberFormat = new Intl.NumberFormat("en");

function secondsAgo(at: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - at.getTime()) / 1000));
  return seconds < 90 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}

function StatusRow({
  icon: Icon,
  tone,
  title,
  children,
}: {
  icon: LucideIcon;
  tone: "ok" | "warn" | "muted";
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 p-4">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "ok" && "text-emerald-600 dark:text-emerald-400",
          tone === "warn" && "text-amber-600 dark:text-amber-400",
          tone === "muted" && "text-muted-foreground",
        )}
        aria-hidden
      />
      <div className="grid min-w-0 gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        <div className="text-sm text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

function WorkerRow({ worker }: { worker: DepsWorkerStatus }) {
  if (worker.state === "running") {
    return (
      <StatusRow icon={CircleCheckIcon} tone="ok" title="deps-worker is running">
        Last heartbeat {secondsAgo(worker.at)}.
      </StatusRow>
    );
  }
  if (worker.state === "missing") {
    return (
      <StatusRow icon={CircleXIcon} tone="warn" title="Dependency checks are not running">
        No heartbeat from the <code className="text-[12px]">deps-worker</code> service in the last 90 seconds. Deploy it (see the
        deployment docs) or check its logs.
      </StatusRow>
    );
  }
  return (
    <StatusRow icon={CircleDashedIcon} tone="muted" title="Status unknown">
      Redis did not answer, so the <code className="text-[12px]">deps-worker</code> heartbeat can&apos;t be read.
    </StatusRow>
  );
}

function SandboxRow({ worker }: { worker: DepsWorkerStatus }) {
  if (worker.state !== "running") {
    return (
      <StatusRow icon={CircleDashedIcon} tone="muted" title="Sandbox status unknown">
        The sandbox is checked by <code className="text-[12px]">deps-worker</code>, which is not reporting.
      </StatusRow>
    );
  }
  if (!worker.sandbox) {
    return (
      <StatusRow icon={CircleXIcon} tone="warn" title="Sandbox unreachable">
        <code className="text-[12px]">deps-worker</code> can&apos;t reach <code className="text-[12px]">deps-sandbox</code>. Checks and
        manifest-only pull requests work; pull requests that regenerate a lockfile are disabled.
      </StatusRow>
    );
  }
  const tools = Object.entries(worker.sandbox.tools).sort(([a], [b]) => a.localeCompare(b));
  return (
    <StatusRow icon={CircleCheckIcon} tone="ok" title="Sandbox reachable">
      {tools.length > 0 ? (
        <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[12px]">
          {tools.map(([tool, version]) => (
            <span key={tool}>
              {tool} {version}
            </span>
          ))}
        </span>
      ) : (
        "Lockfile regeneration is available."
      )}
    </StatusRow>
  );
}

export default async function AdminDependenciesPage() {
  await requireSuperAdmin();
  const view = await getDepsAdminView();

  const stats = [
    { label: "Projects", value: view.projects },
    { label: "Members with projects", value: view.users },
    { label: "Projects with outdated dependencies", value: view.outdatedProjects },
    { label: "Open update pull requests", value: view.openPullRequests },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Dependencies</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Members check their own repositories for outdated npm, Bun and PyPI dependencies, get notified, and (with the GitHub App) receive
          update pull requests.
        </p>
      </div>

      <DepsEnabledToggle enabled={view.enabled} />

      <section aria-labelledby="deps-services-heading" className="space-y-3">
        <h3 id="deps-services-heading" className="font-medium">
          Services
        </h3>
        <ul className="divide-y overflow-hidden rounded-lg border bg-card">
          <WorkerRow worker={view.worker} />
          <SandboxRow worker={view.worker} />
          <StatusRow
            icon={view.appConfigured ? CircleCheckIcon : CircleDashedIcon}
            tone={view.appConfigured ? "ok" : "muted"}
            title={view.appConfigured ? "GitHub App configured" : "No GitHub App"}
          >
            {view.appConfigured ? "Members can install it to get update pull requests and check private repositories." : "Checks work in notify mode only. "}
            <Link href="/admin/github-app" className="font-medium text-foreground underline underline-offset-2">
              {view.appConfigured ? "Manage the App" : "Set up the GitHub App"}
            </Link>
          </StatusRow>
        </ul>
      </section>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-lg border bg-card px-4 py-3">
            <dt className="text-xs text-muted-foreground">{stat.label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{numberFormat.format(stat.value)}</dd>
          </div>
        ))}
      </dl>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <BoxIcon className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          Package managers run only in <code className="text-[11px]">deps-sandbox</code>, which has no secrets and reaches only the public
          registries through <code className="text-[11px]">deps-egress</code>.
        </span>
      </p>
    </div>
  );
}
