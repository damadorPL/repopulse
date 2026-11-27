import { z } from "zod";
import { NOTIFICATION_EVENTS, normalizeEvents } from "./notification-events";

export const notificationEventsSchema = z
  .array(z.enum(NOTIFICATION_EVENTS, "Unknown notification event"), "Choose at least one event")
  .min(1, "Choose at least one event")
  .max(NOTIFICATION_EVENTS.length, "Too many events")
  .transform(normalizeEvents);
