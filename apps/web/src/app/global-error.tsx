"use client";

import { useEffect } from "react";

import "./globals.css";

/**
 * Root-level error boundary rendered when the root layout itself fails.
 * Must define its own `<html>` and `<body>` tags.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[global-error]", error);
  }, [error]);

  return (
    <html lang="en">
      <body className="grid min-h-dvh place-items-center bg-background p-6 text-foreground antialiased">
        <title>Something went wrong · RepoPulse</title>
        <section className="w-full max-w-md rounded-lg border bg-card p-6 text-center text-card-foreground shadow-xs">
          <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            An unexpected error prevented RepoPulse from loading. Try again, or reload the page.
          </p>
          {error.digest ? (
            <p className="mt-3 font-mono text-xs text-muted-foreground">Error ID: {error.digest}</p>
          ) : null}
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => reset()}
              className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
            >
              Try again
            </button>
            {/* oxlint-disable-next-line nextjs/no-html-link-for-pages -- root layout failed; full navigation resets app state. */}
            <a
              href="/"
              className="inline-flex h-9 items-center justify-center rounded-md border bg-background px-4 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              Go home
            </a>
          </div>
        </section>
      </body>
    </html>
  );
}
