import type { Metadata } from "next";
import { BackfillSettingsForm } from "@/components/admin/backfill-settings-form";
import { GitHubQuotaCard } from "@/components/admin/github-quota-card";
import { getBackfillSettingsView, getReapplyCandidates } from "@/server/backfill-settings";
import { getGitHubQuotaView } from "@/server/queries/github-quota";
import { requireSuperAdmin } from "@/server/session";

export const metadata: Metadata = { title: "Release history · Admin · RepoPulse" };

export default async function AdminHistoryPage() {
  const admin = await requireSuperAdmin();
  const settings = await getBackfillSettingsView();
  const defaultTarget = settings.find((s) => s.key === "defaultTarget")!.value;
  const minQuota = settings.find((s) => s.key === "minQuota")!.value;

  const [candidates, quotaResult] = await Promise.all([
    getReapplyCandidates(defaultTarget),
    getGitHubQuotaView(admin),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Release history</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          How many older GitHub Releases RepoPulse imports per repository, automatically and through “Load older releases”.
          Leave a field empty to use the environment variable or the built-in default. Changes apply to the worker&apos;s
          next import, without a restart.
        </p>
      </div>

      <GitHubQuotaCard initialQuota={quotaResult} minQuota={minQuota} />

      <BackfillSettingsForm settings={settings} candidates={candidates} />

      <p className="text-xs text-muted-foreground">
        Git tags (“Releases + tags”) and commits of watched files and folders have no history import: each poll reads the
        newest 20 tags and the newest 10 commits per watched path.
      </p>
    </div>
  );
}
