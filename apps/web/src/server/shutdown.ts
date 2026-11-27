import { prisma } from "@repopulse/db";

const globalForShutdown = globalThis as unknown as { repopulseShutdownRegistered?: boolean };

function disconnect(): void {
  void prisma.$disconnect();
}

/**
 * Registers a one-time graceful shutdown handler in the Node.js runtime so `SIGTERM` / `SIGINT`
 * during Coolify rollouts disconnects the shared Prisma pool cleanly.
 */
export function registerShutdownDisconnect(): void {
  if (globalForShutdown.repopulseShutdownRegistered) return;
  globalForShutdown.repopulseShutdownRegistered = true;

  process.once("SIGTERM", disconnect);
  process.once("SIGINT", disconnect);
}
