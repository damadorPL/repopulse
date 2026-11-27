import { Skeleton } from "@/components/ui/skeleton";

/** Loading skeleton for the tracked repositories list page. */
export default function RepositoriesLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-5" aria-busy="true" aria-label="Loading tracked repositories">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-8 w-32 rounded-md" />
      </div>

      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 min-w-48 flex-1 rounded-md" />
          <Skeleton className="h-8 w-44 rounded-md" />
          <Skeleton className="h-8 w-40 rounded-md" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      </div>

      <ul className="grid gap-3 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <li key={index} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
            <div className="flex items-start gap-3">
              <Skeleton className="size-9 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-8 w-full" />
              </div>
              <div className="flex gap-1">
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="size-8 rounded-md" />
              </div>
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3.5 w-1/2" />
            </div>
            <div className="mt-auto flex gap-1.5 border-t pt-3">
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
