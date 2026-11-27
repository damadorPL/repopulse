import { Skeleton } from "@/components/ui/skeleton";

/** Loading skeleton for the dependency projects list page. */
export default function DependenciesLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-5" aria-busy="true" aria-label="Loading dependency projects">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-8 w-32 rounded-md" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 min-w-48 flex-1 rounded-md" />
        <Skeleton className="h-8 w-44 rounded-md" />
      </div>

      <ul className="divide-y rounded-lg border bg-card">
        {Array.from({ length: 4 }, (_, index) => (
          <li key={index} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <Skeleton className="size-9 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Skeleton className="h-4 w-44" />
                  <Skeleton className="h-5 w-24 rounded-full" />
                  <Skeleton className="h-5 w-14 rounded-full" />
                </div>
                <Skeleton className="h-3.5 w-60" />
              </div>
            </div>
            <div className="flex gap-2 sm:shrink-0">
              <Skeleton className="h-8 w-28 rounded-md" />
              <Skeleton className="h-8 w-24 rounded-md" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
