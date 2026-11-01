"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { encryptToken, INSTANCE_SETTINGS_ID, prisma, SmtpPasswordUnreadableError } from "@repopulse/db";
import { buildTestRelease, dispatchNotification, isNotificationDeliveryError, resolveAppBaseUrl } from "@repopulse/notifications";
import { smtpSettingsInput, type SmtpSettingsInput } from "@/lib/smtp";
import { fail, invalidInput, ok, toActionError, type ActionResult } from "@/server/action-result";
import { getSuperAdminOrThrow } from "@/server/session";
import { fromSmtpSecurity, getSmtpConfig, getSmtpSettingsView, type SmtpSettingsView } from "@/server/smtp-settings";

const EMAIL_SETTINGS_PATH = "/admin/email";
/** Test email cooldown, so the button can't be used to flood an inbox. */
const TEST_COOLDOWN_MS = 10_000;

const testInput = z.object({
  to: z
    .string()
    .trim()
    .max(320)
    .refine((v) => !v || z.email().safeParse(v).success, "Enter a valid email address, or leave it empty")
    .default(""),
});

let lastTestAt = 0;

function revalidateEmailSettings(): void {
  revalidatePath(EMAIL_SETTINGS_PATH);
  revalidatePath("/admin");
  // The email channel in Settings → Notifications depends on these settings.
  revalidatePath("/settings/notifications");
}

/**
 * Saves the SMTP server used for every email notification (web "Send Test" and the worker).
 * The password is AES-256-GCM encrypted; an empty password keeps the saved one.
 */
export async function saveSmtpSettingsAction(input: SmtpSettingsInput): Promise<ActionResult<SmtpSettingsView>> {
  try {
    await getSuperAdminOrThrow();
    const parsed = smtpSettingsInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { host, port, security, user, password, clearPassword, from } = parsed.data;

    // No username = no authentication, so a saved password would never be used.
    const passwordUpdate =
      !user || clearPassword ? { smtpPasswordEncrypted: null } : password ? { smtpPasswordEncrypted: encryptToken(password) } : {};
    const data = {
      smtpHost: host,
      smtpPort: port,
      smtpSecure: fromSmtpSecurity(security),
      smtpUser: user || null,
      smtpFrom: from || null,
      ...passwordUpdate,
    };
    await prisma.instanceSettings.upsert({
      where: { id: INSTANCE_SETTINGS_ID },
      create: { id: INSTANCE_SETTINGS_ID, ...data },
      update: data,
    });
    revalidateEmailSettings();
    return ok(await getSmtpSettingsView());
  } catch (error) {
    return toActionError(error, "saveSmtpSettingsAction");
  }
}

/** Turns email off and forgets the SMTP settings. Existing email rules stay, but fail until SMTP is set up again. */
export async function removeSmtpSettingsAction(): Promise<ActionResult<SmtpSettingsView>> {
  try {
    await getSuperAdminOrThrow();
    const data = { smtpHost: null, smtpPort: 587, smtpSecure: null, smtpUser: null, smtpPasswordEncrypted: null, smtpFrom: null };
    await prisma.instanceSettings.upsert({
      where: { id: INSTANCE_SETTINGS_ID },
      create: { id: INSTANCE_SETTINGS_ID, ...data },
      update: data,
    });
    revalidateEmailSettings();
    return ok(await getSmtpSettingsView());
  } catch (error) {
    return toActionError(error, "removeSmtpSettingsAction");
  }
}

/**
 * Sends the sample release email through the saved SMTP settings right away, to `to` or the
 * super admin's own address.
 */
export async function sendSmtpTestEmailAction(input: { to?: string }): Promise<ActionResult<{ to: string }>> {
  try {
    const admin = await getSuperAdminOrThrow();
    const parsed = testInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);

    const now = Date.now();
    if (now - lastTestAt < TEST_COOLDOWN_MS) {
      const seconds = Math.ceil((TEST_COOLDOWN_MS - (now - lastTestAt)) / 1000);
      return fail("RATE_LIMITED", `Wait ${seconds} s before sending another test email.`);
    }

    let smtp;
    try {
      smtp = await getSmtpConfig();
    } catch (error) {
      if (error instanceof SmtpPasswordUnreadableError) return fail("DELIVERY_FAILED", error.message);
      throw error;
    }
    if (!smtp) return fail("UNAVAILABLE", "Save the SMTP settings first.");
    lastTestAt = now;

    const { release, repository } = buildTestRelease(new Date(now));
    try {
      const result = await dispatchNotification(
        {
          rule: { id: "smtp-settings-test", channel: "EMAIL_INSTANT", destinationUrl: parsed.data.to || null },
          release,
          repository,
          user: { id: admin.id, email: admin.email, name: admin.name },
          test: true,
          readerUrl: `${resolveAppBaseUrl()}${EMAIL_SETTINGS_PATH}`,
        },
        { smtp },
      );
      return ok({ to: result.destination });
    } catch (error) {
      if (isNotificationDeliveryError(error)) return fail("DELIVERY_FAILED", error.message);
      throw error;
    }
  } catch (error) {
    return toActionError(error, "sendSmtpTestEmailAction");
  }
}
