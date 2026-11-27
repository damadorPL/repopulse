import { SearchXIcon } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/** Root 404 page for unmatched routes. */
export default function RootNotFound() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
      <section className="flex w-full max-w-md flex-col items-center rounded-lg border bg-card px-6 py-12 text-center text-card-foreground shadow-xs">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <SearchXIcon className="size-5" aria-hidden />
        </span>
        <p className="mt-4 font-mono text-xs text-muted-foreground">404</p>
        <h1 className="mt-1 text-lg font-semibold tracking-tight">Page not found</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or may have moved.
        </p>
        <Button asChild size="sm" className="mt-5">
          <Link href="/">Back to releases</Link>
        </Button>
      </section>
    </main>
  );
}
