import type { ReactNode } from "react";
import { ShieldIcon } from "lucide-react";
import { AdminNav } from "@/components/admin/admin-nav";
import { requireSuperAdmin } from "@/server/session";

/**
 * The admin panel: every instance-wide setting, super admin only. Layouts and pages render in
 * parallel, so each page calls `requireSuperAdmin()` itself too.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireSuperAdmin();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <ShieldIcon className="size-5 text-muted-foreground" aria-hidden />
            Admin
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Instance-wide settings. Only the super admin sees this panel.</p>
        </div>
        <AdminNav />
      </div>
      {children}
    </div>
  );
}
