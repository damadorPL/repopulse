import type { Metadata } from "next";
import { BackfillSettingsForm } from "@/components/admin/backfill-settings-form";
import { countReapplyCandidates, getBackfillSettingsView } from "@/server/backfill-settings";
import { requireSuperAdmin } from "@/server/session";

export const metadata: Metadata = { title: "Release history · Admin · RepoPulse" };

export default async function AdminHistoryPage() {
  await requireSuperAdmin();
  const settings = await getBackfillSettingsView();
  const defaultTarget = settings.find((s) => s.key === "defaultTarget")!.value;
  const reapplyCandidates = await countReapplyCandidates(defaultTarget);

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

      <BackfillSettingsForm settings={settings} reapplyCandidates={reapplyCandidates} />

      <p className="text-xs text-muted-foreground">
        Git tags (“Releases + tags”) and commits of watched files and folders have no history import: each poll reads the
        newest 20 tags and the newest 10 commits per watched path.
      </p>
    </div>
  );
}
