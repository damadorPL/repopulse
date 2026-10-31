import { prisma } from "@repopulse/db";

// Never prerender or cache: the health check must hit the database on every
// request, and `next build` must not attempt a DB connection.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const timestamp = new Date().toISOString();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", timestamp }, { status: 200 });
  } catch (error) {
    console.error("[health] database check failed:", error);
    return Response.json(
      { status: "error", message: "database unavailable", timestamp },
      { status: 503 },
    );
  }
}
