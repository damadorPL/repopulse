import { cache } from "react";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { encryptToken, prisma, type User as DbUser } from "@repopulse/db";

export class UnauthorizedError extends Error {
  constructor(message = "You must be signed in to do that.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Auth.js v5 — GitHub OAuth with JWT sessions.
 *
 * Env (read automatically): AUTH_SECRET, AUTH_GITHUB_ID, AUTH_GITHUB_SECRET, and
 * AUTH_URL / NEXTAUTH_URL (Coolify injects SERVICE_FQDN_WEB into NEXTAUTH_URL).
 *
 * The GitHub access token is never put in the session cookie: on sign-in it is
 * AES-256-GCM encrypted and stored on the `User` row; the JWT only carries `userId`.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  // Self-hosted behind Coolify's reverse proxy: trust X-Forwarded-Host/Proto.
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login", error: "/login" },
  providers: [
    GitHub({
      authorization: { params: { scope: "read:user user:email" } },
    }),
  ],
  callbacks: {
    async jwt({ token, user, account, profile }) {
      // `account` / `profile` are only present on the sign-in request.
      if (account?.provider === "github" && account.access_token && profile?.id != null) {
        const githubId = String(profile.id);
        const login = typeof profile.login === "string" ? profile.login : undefined;
        // Auth.js resolves the primary email via /user/emails (user:email scope); fall
        // back to the GitHub noreply address so the required `email` column is never empty.
        const email =
          user?.email ?? profile.email ?? `${githubId}+${login ?? "user"}@users.noreply.github.com`;
        const name = user?.name ?? profile.name ?? login ?? null;
        const avatarUrl =
          user?.image ?? (typeof profile.avatar_url === "string" ? profile.avatar_url : null);
        const githubAccessTokenEncrypted = encryptToken(account.access_token);

        const dbUser = await prisma.user.upsert({
          where: { githubId },
          create: { githubId, email, name, avatarUrl, githubAccessTokenEncrypted },
          update: { email, name, avatarUrl, githubAccessTokenEncrypted },
          select: { id: true },
        });
        token.userId = dbUser.id;
      }
      return token;
    },
    session({ session, token }) {
      if (typeof token.userId === "string") {
        session.user.id = token.userId;
      }
      return session;
    },
  },
});

/**
 * Returns the signed-in user's DB row, or throws {@link UnauthorizedError}.
 * Memoized per request so multiple callers in one render/action share one query.
 */
export const getCurrentUserOrThrow = cache(async (): Promise<DbUser> => {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new UnauthorizedError();
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    // Valid cookie but the row is gone (e.g. DB reset) — treat as signed out.
    throw new UnauthorizedError();
  }
  return user;
});
