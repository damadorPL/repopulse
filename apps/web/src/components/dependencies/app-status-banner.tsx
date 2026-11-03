import { CircleCheckIcon, CircleDashedIcon, ExternalLinkIcon, InfoIcon, UsersIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AppRepoStatus, PrOwnerView } from "@/server/queries/dependencies";

function Banner({ tone, icon, children }: { tone: "ok" | "warn" | "muted"; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-lg border px-4 py-3 text-sm",
        tone === "ok" && "border-emerald-300/60 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
        tone === "warn" && "border-amber-300/60 bg-amber-500/10 text-amber-900 dark:text-amber-200",
        tone === "muted" && "bg-muted/40 text-muted-foreground",
      )}
    >
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * GitHub App status of a project's repository (§3.7.3 header): not set up, not installed (with an
 * install link that pre-selects the repository when possible), installed, or PRs managed by another
 * RepoPulse user.
 */
export function AppStatusBanner({ status, prOwner, fullName }: { status: AppRepoStatus; prOwner: PrOwnerView; fullName: string }) {
  if (prOwner.kind === "other") {
    return (
      <Banner tone="warn" icon={<UsersIcon aria-hidden />}>
        <span className="font-medium">PRs are managed by another RepoPulse user</span> ({prOwner.ownerName}). Only one RepoPulse project
        per repository opens update pull requests; this one can notify you.
      </Banner>
    );
  }
  switch (status.state) {
    case "not_configured":
      return (
        <Banner tone="muted" icon={<InfoIcon aria-hidden />}>
          Update pull requests need the RepoPulse GitHub App, which the administrator has not set up. Checks and notifications work
          without it.
        </Banner>
      );
    case "not_installed":
      return (
        <Banner tone="warn" icon={<CircleDashedIcon aria-hidden />}>
          <span className="font-medium">Not installed:</span>{" "}
          <a href={status.installUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium underline underline-offset-2">
            install the RepoPulse App on {fullName}
            <ExternalLinkIcon className="size-3.5" aria-hidden />
          </a>{" "}
          to get update pull requests (and to check it if it is private). Then use “Check now”.
        </Banner>
      );
    case "installed":
      return (
        <Banner tone="ok" icon={<CircleCheckIcon aria-hidden />}>
          <span className="font-medium">GitHub App installed</span> on {fullName}
          {prOwner.kind === "self" ? ". This project manages its update pull requests." : "."}
        </Banner>
      );
    case "unknown":
      return (
        <Banner tone="muted" icon={<InfoIcon aria-hidden />}>
          GitHub App status unknown: {status.message}
        </Banner>
      );
  }
}
