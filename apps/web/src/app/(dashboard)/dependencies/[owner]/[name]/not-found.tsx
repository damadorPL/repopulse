import Link from "next/link";
import { ArrowLeftIcon, PackageSearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/server/session";

/**
 * `/dependencies/<owner>/<name>` that is not one of the signed-in user's projects (unknown, removed,
 * or another user's). Not-found files get no params, so the page stays generic.
 */
export default async function DependencyProjectNotFound() {
  await requireUser();
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link href="/dependencies" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon className="size-4" aria-hidden />
        Dependencies
      </Link>
      <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-14 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <PackageSearchIcon className="size-5" aria-hidden />
        </span>
        <h1 className="mt-4 font-medium">This repository is not one of your projects</h1>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">Add it from the Dependencies page to check its dependencies.</p>
        <Button asChild className="mt-5" size="sm">
          <Link href="/dependencies">Go to Dependencies</Link>
        </Button>
      </div>
    </div>
  );
}
