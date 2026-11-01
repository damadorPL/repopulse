import type { Metadata } from "next";
import { BellRingIcon, ShieldCheckIcon } from "lucide-react";
import { AddNotificationRuleForm } from "@/components/notifications/add-notification-rule-form";
import { NotificationRuleItem } from "@/components/notifications/notification-rule-item";
import { getDashboardData } from "@/server/queries/feed";
import { getNotificationRules, MAX_NOTIFICATION_RULES } from "@/server/queries/notifications";
import { requireUser } from "@/server/session";
import { isSmtpConfigured } from "@/server/smtp-settings";

export const metadata: Metadata = { title: "Notifications · RepoPulse" };

export default async function NotificationSettingsPage() {
  const user = await requireUser();
  const [rules, dashboard, smtpConfigured] = await Promise.all([
    getNotificationRules(user.id),
    getDashboardData(user.id),
    isSmtpConfigured(),
  ]);
  const tags = dashboard.tags.map(({ id, name, slug, colorHex }) => ({ id, name, slug, colorHex }));
  const activeCount = rules.filter((rule) => rule.enabled).length;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Get new releases delivered to Discord, Slack, ntfy, Gotify, email or your own webhook. In-app unread badges are always on.
        </p>
      </div>

      <AddNotificationRuleForm
        tags={tags}
        smtpConfigured={smtpConfigured}
        canConfigureSmtp={user.isSuperAdmin}
        limitReached={rules.length >= MAX_NOTIFICATION_RULES}
      />

      <section aria-labelledby="rules-heading" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="rules-heading" className="font-medium">
            Rules
          </h2>
          {rules.length > 0 ? (
            <p className="text-sm text-muted-foreground tabular-nums">
              {activeCount} of {rules.length} active
            </p>
          ) : null}
        </div>

        {rules.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-12 text-center">
            <BellRingIcon className="mx-auto size-6 text-muted-foreground" aria-hidden />
            <h3 className="mt-3 font-medium">No notification rules yet</h3>
            <p className="mt-1 text-sm text-muted-foreground">Add one above, then use “Send Test” to check the delivery.</p>
          </div>
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border bg-card">
            {rules.map((rule) => (
              <NotificationRuleItem key={rule.id} rule={rule} />
            ))}
          </ul>
        )}
      </section>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          Webhook URLs are checked before every delivery. Addresses on private networks (localhost, 10.x, 172.16–31.x, 192.168.x) are
          blocked unless the server sets <code className="text-[11px]">ALLOW_INTERNAL_WEBHOOK_HOSTS</code>. Cloud metadata addresses are
          always blocked.
        </span>
      </p>
    </div>
  );
}
