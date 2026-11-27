/** Toast id shared with `SyncRepoButton`, so the outcome replaces the "Syncing…" toast. */
export function syncToastId(repositoryId: string): string {
  return `sync-${repositoryId}`;
}

/** Toast id of a dependency check, so a "Check now" button's loading toast is replaced by the outcome. */
export function depsScanToastId(projectId: string): string {
  return `deps-scan-${projectId}`;
}
