"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RotateCcwIcon, TriangleExclamationPointIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Segment error boundary for dashboard routes so the sidebar and top navbar stay intact. */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[dashboard-error]", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg py-10">
      <section
        role="alert"
        className="flex flex-col items-center rounded-lg border bg-card px-6 py-10 text-center text-card-foreground shadow-xs"
      >
        <span className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <TriangleExclamationPointIcon className="size-5" aria-hidden />
        </span>
        <h1 className="mt-4 text-lg font-semibold tracking-tight">Could not load this view</h1>
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
          Something went wrong while loading this page. You can retry the request or return to your release feed.
        </p>
        {error.digest ? <p className="mt-3 font-mono text-xs text-muted-foreground">Error ID: {error.digest}</p> : null}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button type="button" size="sm" onClick={() => reset()}>
            <RotateCcwIcon />
            Try again
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/">Back to feed</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
