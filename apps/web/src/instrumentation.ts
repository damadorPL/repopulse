/**
 * Next.js instrumentation hook: delegates Node.js-only shutdown wiring to a dynamic import so
 * Turbopack does not pull `process.once` into the Edge runtime bundle.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerShutdownDisconnect } = await import("@/server/shutdown");
  registerShutdownDisconnect();
}
