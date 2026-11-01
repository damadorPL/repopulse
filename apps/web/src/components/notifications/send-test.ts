"use client";

import { toast } from "sonner";
import { sendTestNotificationAction } from "@/server/actions/notifications";

/** Runs "Send Test" with one toast that goes loading → success / error. Resolves to whether it was delivered. */
export async function sendTestWithToast(ruleId: string, channelLabel: string): Promise<boolean> {
  const id = toast.loading(`Sending a test notification via ${channelLabel}…`);
  const result = await sendTestNotificationAction({ ruleId });
  if (result.ok) {
    toast.success(`Test notification sent via ${result.data.channel}`, {
      id,
      description: `Delivered to ${result.data.destination}. Check that it arrived.`,
    });
    return true;
  }
  toast.error(result.error.code === "DELIVERY_FAILED" ? "Test notification failed" : result.error.message, {
    id,
    description: result.error.code === "DELIVERY_FAILED" ? result.error.message : undefined,
  });
  return false;
}
