import { z } from "zod";
import { isValidSmtpHost, SMTP_SECURITY } from "./smtp";

/** `releases@example.com` or `RepoPulse <releases@example.com>`. */
const ADDRESS_WITH_NAME_RE = /^([^<>\r\n]*)<([^<>\s]+)>$/;
const emailSchema = z.email();

export function isValidSender(value: string): boolean {
  const match = ADDRESS_WITH_NAME_RE.exec(value);
  return match ? emailSchema.safeParse(match[2]).success : emailSchema.safeParse(value).success;
}

/** Input of `saveSmtpSettingsAction`, shared with the form for its limits. */
export const smtpSettingsInput = z.object({
  host: z
    .string()
    .trim()
    .min(1, "Enter the SMTP server host name")
    .max(253, "The host name is too long")
    .refine(isValidSmtpHost, "Enter a host name such as smtp.example.com, without http:// or a port"),
  port: z
    .number({ error: "Enter a port" })
    .int("Enter a whole number")
    .min(1, "Ports go from 1 to 65535")
    .max(65535, "Ports go from 1 to 65535"),
  security: z.enum(SMTP_SECURITY),
  user: z.string().trim().max(320, "The username can be at most 320 characters"),
  /** Empty = keep the saved password. */
  password: z.string().max(1024, "The password can be at most 1024 characters"),
  clearPassword: z.boolean(),
  from: z
    .string()
    .trim()
    .max(320, "The sender can be at most 320 characters")
    .refine(
      (v) => !v || isValidSender(v),
      "Enter an address, optionally with a name: RepoPulse <releases@example.com>",
    ),
});
export type SmtpSettingsInput = z.input<typeof smtpSettingsInput>;
