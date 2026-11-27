import { prisma } from "@repopulse/db";
import { connection } from "next/server";

const HEALTH_QUERY_TIMEOUT_MS = 3_000;

// Never prerender or cache: the health check must hit the database on every
// request, and `next build` must not attempt a DB connection.
export async function GET(): Promise<Response> {
  await connection();
  const timestamp = new Date().toISOString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("health check timeout")), HEALTH_QUERY_TIMEOUT_MS);
      }),
    ]);
    return Response.json({ status: "ok", timestamp }, { status: 200 });
  } catch (error) {
    console.error("[health] database check failed:", error);
    return Response.json({ status: "error", message: "database unavailable", timestamp }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}
