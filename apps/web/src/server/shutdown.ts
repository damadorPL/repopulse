import { prisma } from "@repopulse/db";

declare global {
  var repopulseShutdownRegistered: boolean | undefined;
}

function disconnect(): void {
  void prisma.$disconnect();
}

/**
 * Registers a one-time graceful shutdown handler in the Node.js runtime so `SIGTERM` / `SIGINT`
 * during Coolify rollouts disconnects the shared Prisma pool cleanly.
 */
export function registerShutdownDisconnect(): void {
  if (globalThis.repopulseShutdownRegistered) return;
  globalThis.repopulseShutdownRegistered = true;

  process.once("SIGTERM", disconnect);
  process.once("SIGINT", disconnect);
}
