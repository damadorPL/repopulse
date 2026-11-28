"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};
let cachedClientNow: Date | null = null;
export function getClientNow(): Date {
  return (cachedClientNow ??= new Date());
}
const getServerNow = () => null;

/**
 * The current time on the client. `null` during the server render and hydration: bucketing by
 * local day needs the browser's time zone, so nothing date-dependent is rendered on the server.
 */
export function useClientNow(): Date | null {
  return useSyncExternalStore(emptySubscribe, getClientNow, getServerNow);
}
