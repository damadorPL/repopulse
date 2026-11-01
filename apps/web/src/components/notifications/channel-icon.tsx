import type { ComponentType, SVGProps } from "react";
import { BellIcon, BellRingIcon, HashIcon, MailIcon, MessagesSquareIcon, SmartphoneIcon, WebhookIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Lucide has no brand marks, so each channel gets a generic glyph and its own tint. */
const ICONS: Record<string, { icon: ComponentType<SVGProps<SVGSVGElement>>; className: string }> = {
  DISCORD_WEBHOOK: { icon: MessagesSquareIcon, className: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400" },
  SLACK_WEBHOOK: { icon: HashIcon, className: "bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400" },
  NTFY_WEBHOOK: { icon: BellRingIcon, className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  GOTIFY_WEBHOOK: { icon: SmartphoneIcon, className: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  EMAIL_INSTANT: { icon: MailIcon, className: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  EMAIL_DIGEST: { icon: MailIcon, className: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  CUSTOM_WEBHOOK: { icon: WebhookIcon, className: "bg-slate-500/10 text-slate-700 dark:text-slate-300" },
};

const FALLBACK = { icon: BellIcon, className: "bg-muted text-muted-foreground" };

export function ChannelGlyph({ channel, className }: { channel: string; className?: string }) {
  const { icon: Icon } = ICONS[channel] ?? FALLBACK;
  return <Icon aria-hidden className={cn("size-4", className)} />;
}

/** Rounded tile with the channel glyph, used in the rule list. */
export function ChannelIcon({ channel, className }: { channel: string; className?: string }) {
  const { className: tint } = ICONS[channel] ?? FALLBACK;
  return (
    <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-md", tint, className)}>
      <ChannelGlyph channel={channel} />
    </span>
  );
}
