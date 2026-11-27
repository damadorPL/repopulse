/** How the SMTP connection is secured. `auto` = implicit TLS on port 465, STARTTLS otherwise. */
export const SMTP_SECURITY = ["auto", "tls", "starttls"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

export const SMTP_SECURITY_LABELS: Record<SmtpSecurity, string> = {
  auto: "Automatic",
  tls: "TLS (implicit)",
  starttls: "STARTTLS",
};

export const SMTP_SECURITY_HINTS: Record<SmtpSecurity, string> = {
  auto: "TLS on port 465, STARTTLS (when offered) on any other port.",
  tls: "Encrypted from the start. Usually port 465.",
  starttls: "Upgrades to TLS when the server offers it. Usually port 587 or 25.",
};

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV6_RE = /^\[?[0-9a-f:.]+\]?$/i;

export function isValidSmtpHost(value: string): boolean {
  return HOSTNAME_RE.test(value) || (value.includes(":") && IPV6_RE.test(value));
}
