"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { INSTANCE_SETTINGS_ID, prisma } from "@repopulse/db";
import { applyBackfillOverrides, BACKFILL_LIMITS, readBackfillConfig, RELEASE_BACKFILL_PRIORITY, type BackfillSettingKey } from "@repopulse/queue";
import { fail, invalidInput, ok, toActionError, type ActionResult } from "@/server/action-result";
import { enqueueReleaseBackfill } from "@/server/backfill-queue";
import {
  getBackfillConfig,
  getBackfillSettingsView,
  reapplyCandidatesWhere,
  type BackfillSettingView,
} from "@/server/backfill-settings";
import { isRealtimeConfigured } from "@/server/realtime";
import { getSuperAdminOrThrow } from "@/server/session";

const ADMIN_HISTORY_PATH = "/admin/history";

function setting(key: BackfillSettingKey) {
  const { min, max } = BACKFILL_LIMITS[key];
  return z.number().int(`Enter a whole number`).min(min, `At least ${min}`).max(max, `At most ${max}`).nullable();
}

/** Each value overrides the environment / default; `null` resets it. */
const backfillSettingsInput = z.object({
  defaultTarget: setting("defaultTarget"),
  maxAgeDays: setting("maxAgeDays"),
  hardCap: setting("hardCap"),
  minQuota: setting("minQuota"),
  deepStep: setting("deepStep"),
  deepCooldownMinutes: setting("deepCooldownMinutes"),
});

export type BackfillSettingsInput = z.input<typeof backfillSettingsInput>;

function revalidateBackfillSettings(): void {
  revalidatePath(ADMIN_HISTORY_PATH);
  revalidatePath("/admin");
  // "Load older releases" depends on the hard cap.
  revalidatePath("/repositories");
}

/**
 * Saves the release history settings. They apply to the worker's next backfill job and to
 * "Load older releases" right away, without a restart.
 */
export async function saveBackfillSettingsAction(input: BackfillSettingsInput): Promise<ActionResult<BackfillSettingView[]>> {
  try {
    await getSuperAdminOrThrow();
    const parsed = backfillSettingsInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const values = parsed.data;

    // The worker would silently clamp it; say so instead.
    const effective = applyBackfillOverrides(readBackfillConfig(), values);
    const requestedTarget = values.defaultTarget ?? readBackfillConfig().defaultTarget;
    if (requestedTarget > effective.hardCap) {
      return fail("INVALID_INPUT", `The automatic import target (${requestedTarget}) can't be above the hard cap (${effective.hardCap}).`);
    }

    const data = {
      backfillDefaultTarget: values.defaultTarget,
      backfillMaxAgeDays: values.maxAgeDays,
      backfillHardCap: values.hardCap,
      backfillMinQuota: values.minQuota,
      backfillDeepStep: values.deepStep,
      backfillDeepCooldownMinutes: values.deepCooldownMinutes,
    };
    await prisma.instanceSettings.upsert({
      where: { id: INSTANCE_SETTINGS_ID },
      create: { id: INSTANCE_SETTINGS_ID, ...data },
      update: data,
    });
    revalidateBackfillSettings();
    return ok(await getBackfillSettingsView());
  } catch (error) {
    return toActionError(error, "saveBackfillSettingsAction");
  }
}

/**
 * Re-runs the automatic import for tracked repositories, so a raised target or age limit also
 * reaches repositories imported before the change. Only repositories whose import finished with
 * older releases left on GitHub and whose target was not raised by "Load older releases" beyond
 * the automatic one. Imported history stays read and sends no notifications, as always.
 */
export async function reapplyBackfillSettingsAction(): Promise<ActionResult<{ queued: number }>> {
  try {
    await getSuperAdminOrThrow();
    const { defaultTarget } = await getBackfillConfig();

    const where = reapplyCandidatesWhere(defaultTarget);
    const repositories = await prisma.repository.findMany({ where, select: { id: true } });
    if (repositories.length === 0) return ok({ queued: 0 });

    const ids = repositories.map((r) => r.id);
    await prisma.repository.updateMany({
      where: { ...where, id: { in: ids } },
      data: { backfillTarget: defaultTarget, backfillStatus: "QUEUED" },
    });

    // Best effort: the scheduler's sweep also picks up QUEUED repositories, a few per run.
    if (isRealtimeConfigured()) {
      for (const repositoryId of ids) {
        try {
          await enqueueReleaseBackfill({ repositoryId, trigger: "sweep" }, RELEASE_BACKFILL_PRIORITY.automatic);
        } catch (error) {
          console.warn("[reapplyBackfillSettingsAction] could not queue the backfill; the scheduler sweep will", error);
          break;
        }
      }
    }

    revalidateBackfillSettings();
    return ok({ queued: ids.length });
  } catch (error) {
    return toActionError(error, "reapplyBackfillSettingsAction");
  }
}
