"use server";

import { fail, ok, toActionError, type ActionResult } from "@/server/action-result";
import { getGitHubQuotaView, type GitHubQuotaView } from "@/server/queries/github-quota";
import { getSuperAdminOrThrow } from "@/server/session";

/**
 * Re-reads GitHub API quota for the super admin.
 * Used by the "Refresh" button on the GitHub API quota card in Admin → Release history.
 */
export async function refreshGitHubQuotaAction(): Promise<ActionResult<GitHubQuotaView>> {
  try {
    const admin = await getSuperAdminOrThrow();
    const result = await getGitHubQuotaView(admin);
    if (!result.ok) {
      return fail("INTERNAL", result.error);
    }
    return ok(result.data);
  } catch (error) {
    return toActionError(error, "refreshGitHubQuotaAction");
  }
}
