import { connection } from "next/server";
import { prisma } from "@repopulse/db";

// Never prerender or cache: the health check must hit the database on every
// request, and `next build` must not attempt a DB connection.
export async function GET(): Promise<Response> {
  await connection();
  const timestamp = new Date().toISOString();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", timestamp }, { status: 200 });
  } catch (error) {
    console.error("[health] database check failed:", error);
    return Response.json({ status: "error", message: "database unavailable", timestamp }, { status: 503 });
  }
}
