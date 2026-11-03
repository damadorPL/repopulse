"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircleIcon, PackageSearchIcon } from "lucide-react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/feed/relative-time";
import { depsScanToastId } from "@/components/realtime/sse-listener";
import { Button } from "@/components/ui/button";
import { dependencyProjectHref } from "@/lib/dependency-list-filters";
import { formatOutdatedCounts, totalOutdated, type LevelCounts } from "@/lib/dependency-settings";
import { addDependencyProjectsAction } from "@/server/actions/dependencies";

/**
 * "Dependencies" card of the repository settings page (Slice 08 §3.7.4): adds the tracked repository
 * as a dependency project, or summarizes the existing project with a link to it.
 */
export function RepositoryDependenciesCard({
  subscriptionId,
  fullName,
  project,
}: {
  subscriptionId: string;
  fullName: string;
  project: { fullName: string; outdated: LevelCounts; lastScannedAt: Date | null; scanStatus: string } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function add() {
    startTransition(async () => {
      const result = await addDependencyProjectsAction({ sources: [{ subscriptionId }], updateMode: "NOTIFY", notifyOnFirstScan: false });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      const { added, existing, failed, scansQueued } = result.data;
      const target = added[0] ?? existing[0];
      if (!target) {
        toast.error(failed[0]?.message ?? `Could not add ${fullName}.`);
        return;
      }
      if (added[0] && scansQueued) {
        toast.loading(`Checking the dependencies of ${target.fullName}…`, { id: depsScanToastId(target.projectId), duration: 120_000 });
      }
      router.push(dependencyProjectHref(target.fullName));
    });
  }

  if (project) {
    const total = totalOutdated(project.outdated);
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {project.scanStatus === "QUEUED" || project.scanStatus === "SCANNING" ? (
            "Checking its dependencies…"
          ) : !project.lastScannedAt ? (
            "Its dependencies have not been checked yet."
          ) : total === 0 ? (
            <>
              Dependencies are up to date · checked <RelativeTime date={project.lastScannedAt} />
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">{formatOutdatedCounts(project.outdated)}</span> outdated · checked{" "}
              <RelativeTime date={project.lastScannedAt} />
            </>
          )}
        </p>
        <Button variant="outline" size="sm" asChild>
          <Link href={dependencyProjectHref(project.fullName)}>
            <PackageSearchIcon />
            Open project
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        If {fullName} is your own repository, RepoPulse can check its npm, Bun and Python dependencies and tell you when they are outdated.
      </p>
      <Button size="sm" onClick={add} disabled={pending}>
        {pending ? <LoaderCircleIcon className="animate-spin" /> : <PackageSearchIcon />}
        Check this repository&apos;s dependencies
      </Button>
    </div>
  );
}
