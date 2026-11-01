import type { Metadata } from "next";
import { TicketIcon } from "lucide-react";
import { CreateInviteForm } from "@/components/access/create-invite-form";
import { InviteItem } from "@/components/access/invite-item";
import { RegistrationToggle } from "@/components/access/registration-toggle";
import { getInvites, getMemberCount } from "@/server/queries/access";
import { isPublicRegistrationOpen } from "@/server/registration";
import { requireSuperAdmin } from "@/server/session";

export const metadata: Metadata = { title: "Access · RepoPulse" };

export default async function AccessSettingsPage() {
  await requireSuperAdmin();

  const [publicRegistration, invites, memberCount] = await Promise.all([
    isPublicRegistrationOpen(),
    getInvites(),
    getMemberCount(),
  ]);
  const pendingCount = invites.filter((invite) => invite.status === "pending").length;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Access</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control who can create an account on this RepoPulse instance.{" "}
          <span className="tabular-nums">
            {memberCount} {memberCount === 1 ? "member" : "members"}
          </span>{" "}
          so far.
        </p>
      </div>

      <RegistrationToggle publicRegistration={publicRegistration} />

      <CreateInviteForm />

      <section aria-labelledby="invites-heading" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="invites-heading" className="font-medium">
            Invite links
          </h2>
          {invites.length > 0 ? (
            <p className="text-sm text-muted-foreground tabular-nums">
              {pendingCount} of {invites.length} pending
            </p>
          ) : null}
        </div>

        {invites.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-12 text-center">
            <TicketIcon className="mx-auto size-6 text-muted-foreground" aria-hidden />
            <h3 className="mt-3 font-medium">No invite links yet</h3>
            <p className="mt-1 text-sm text-muted-foreground">Create one above and send it to the person you want to invite.</p>
          </div>
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border bg-card">
            {invites.map((invite) => (
              <InviteItem key={invite.id} invite={invite} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
