import { z } from "zod";

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
/** `releases@example.com` or `RepoPulse <releases@example.com>`. */
const ADDRESS_WITH_NAME_RE = /^([^<>\r\n]*)<([^<>\s]+)>$/;

export function isValidSmtpHost(value: string): boolean {
  return HOSTNAME_RE.test(value) || (value.includes(":") && IPV6_RE.test(value));
}

export function isValidSender(value: string): boolean {
  const email = z.email();
  const match = ADDRESS_WITH_NAME_RE.exec(value);
  return match ? email.safeParse(match[2]).success : email.safeParse(value).success;
}

/** Input of `saveSmtpSettingsAction`, shared with the form for its limits. */
export const smtpSettingsInput = z.object({
  host: z
    .string()
    .trim()
    .min(1, "Enter the SMTP server host name")
    .max(253, "The host name is too long")
    .refine(isValidSmtpHost, "Enter a host name such as smtp.example.com, without http:// or a port"),
  port: z.number("Enter a port").int("Enter a whole number").min(1, "Ports go from 1 to 65535").max(65535, "Ports go from 1 to 65535"),
  security: z.enum(SMTP_SECURITY),
  user: z.string().trim().max(320, "The username can be at most 320 characters"),
  /** Empty = keep the saved password. */
  password: z.string().max(1024, "The password can be at most 1024 characters"),
  clearPassword: z.boolean(),
  from: z
    .string()
    .trim()
    .max(320, "The sender can be at most 320 characters")
    .refine((v) => !v || isValidSender(v), "Enter an address, optionally with a name: RepoPulse <releases@example.com>"),
});
export type SmtpSettingsInput = z.input<typeof smtpSettingsInput>;
