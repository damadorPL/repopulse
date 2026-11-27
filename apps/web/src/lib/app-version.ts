const REPO_URL = "https://github.com/damadorPL/repopulse";

/** Returns the GitHub release URL for the current app version, or the releases index if unset. */
export function appReleaseUrl(version = process.env.APP_VERSION): string {
  return version ? `${REPO_URL}/releases/tag/v${version}` : `${REPO_URL}/releases`;
}
