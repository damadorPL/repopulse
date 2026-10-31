import { redirect } from "next/navigation";
import type { User as DbUser } from "@repopulse/db";
import { getCurrentUserOrThrow, UnauthorizedError } from "@/lib/auth";

/**
 * For Server Components: the signed-in user, or a redirect to /login.
 * Layouts and pages render in parallel, so every page must call this itself rather than
 * relying on the layout's check.
 */
export async function requireUser(): Promise<DbUser> {
  try {
    return await getCurrentUserOrThrow();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }
}
