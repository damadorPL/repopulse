"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { INSTANCE_SETTINGS_ID, prisma } from "@repopulse/db";

import { invalidInput, ok, toActionError, type ActionResult } from "@/server/action-result";
import { invalidateDepsEnabledCache } from "@/server/deps-enabled-cache";
import { getSuperAdminOrThrow } from "@/server/session";

const enabledInput = z.strictObject({ enabled: z.boolean({ error: "Choose on or off" }) });

/**
 * Admin → Dependencies: turns the Dependencies module on or off for the whole instance. While off, the
 * sidebar link is hidden, `/dependencies` says so, and `deps-worker` schedules no scans. Projects and
 * their settings are kept.
 */
export async function setDepsEnabledAction(input: { enabled: boolean }): Promise<ActionResult<{ enabled: boolean }>> {
  try {
    await getSuperAdminOrThrow();
    const parsed = enabledInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { enabled } = parsed.data;

    await prisma.instanceSettings.upsert({
      where: { id: INSTANCE_SETTINGS_ID },
      create: { id: INSTANCE_SETTINGS_ID, depsEnabled: enabled },
      update: { depsEnabled: enabled },
    });
    invalidateDepsEnabledCache();
    revalidatePath("/admin/dependencies");
    revalidatePath("/admin");
    // The sidebar link lives in the dashboard layout.
    revalidatePath("/", "layout");
    return ok({ enabled });
  } catch (error) {
    return toActionError(error, "setDepsEnabledAction");
  }
}
