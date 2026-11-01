import { notFound, redirect } from "next/navigation";
import type { User as DbUser } from "@repopulse/db";
import { ForbiddenError, getCurrentUserOrThrow, UnauthorizedError } from "@/lib/auth";

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

/** For instance-settings pages: the super admin, a 404 for everyone else, or a redirect to /login. */
export async function requireSuperAdmin(): Promise<DbUser> {
  const user = await requireUser();
  if (!user.isSuperAdmin) notFound();
  return user;
}

/** For Server Actions: the super admin, or throws {@link ForbiddenError} / `UnauthorizedError`. */
export async function getSuperAdminOrThrow(): Promise<DbUser> {
  const user = await getCurrentUserOrThrow();
  if (!user.isSuperAdmin) throw new ForbiddenError();
  return user;
}
