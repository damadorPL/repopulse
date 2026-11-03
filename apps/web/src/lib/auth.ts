import { cache } from "react";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import type { Account, Profile, User as AuthUser } from "next-auth";
import { cookies } from "next/headers";
import { encryptToken, prisma, type User as DbUser } from "@repopulse/db";
import { INVITE_COOKIE } from "@/lib/invites";
import { admitGitHubUser, type GitHubUserFields } from "@/server/registration";

export class UnauthorizedError extends Error {
  constructor(message = "You must be signed in to do that.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Signed in, but not allowed: instance settings are for the super admin only. */
export class ForbiddenError extends Error {
  constructor(message = "Only the super admin can change instance settings.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Maps a GitHub sign-in to `User` columns; null when the provider didn't return what we need. */
function githubUserFields(
  user: AuthUser | undefined,
  account: Account | null | undefined,
  profile: Profile | undefined,
): GitHubUserFields | null {
  if (!account?.access_token || profile?.id == null) return null;
  const githubId = String(profile.id);
  const login = typeof profile.login === "string" ? profile.login : undefined;
  // Auth.js resolves the primary email via /user/emails (user:email scope); fall
  // back to the GitHub noreply address so the required `email` column is never empty.
  const email = user?.email ?? profile.email ?? `${githubId}+${login ?? "user"}@users.noreply.github.com`;
  const name = user?.name ?? profile.name ?? login ?? null;
  const avatarUrl = user?.image ?? (typeof profile.avatar_url === "string" ? profile.avatar_url : null);
  return { githubId, email, name, avatarUrl, githubAccessTokenEncrypted: encryptToken(account.access_token) };
}

/** The GitHub login of a sign-in (a cache: logins can change, so it is refreshed on every sign-in). */
function githubLoginOf(profile: Profile | undefined): string | null {
  return typeof profile?.login === "string" && profile.login.length > 0 ? profile.login : null;
}

/**
 * Auth.js v5 — GitHub OAuth with JWT sessions.
 *
 * Env (read automatically): AUTH_SECRET, AUTH_GITHUB_ID, AUTH_GITHUB_SECRET, and
 * AUTH_URL / NEXTAUTH_URL (Coolify injects SERVICE_URL_WEB into NEXTAUTH_URL).
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
    /** Registration gate: existing users pass; new ones need public sign-up or an invite link. */
    async signIn({ user, account, profile }) {
      if (account?.provider !== "github") return true;
      const fields = githubUserFields(user, account, profile);
      if (!fields) return false;
      const cookieStore = await cookies();
      const result = await admitGitHubUser(fields, cookieStore.get(INVITE_COOKIE)?.value);
      if (result === true) {
        // Single-use either way; best effort, since the cookie expires within the hour anyway.
        try {
          cookieStore.delete(INVITE_COOKIE);
        } catch {}
      }
      return result;
    },
    async jwt({ token, user, account, profile }) {
      // `account` / `profile` are only present on the sign-in request.
      const fields = account?.provider === "github" ? githubUserFields(user, account, profile) : null;
      if (fields) {
        const { githubId, ...profileFields } = fields;
        // `githubLogin` feeds the collaborator permission check of dependency update PRs (Slice 08).
        const githubLogin = githubLoginOf(profile);
        const dbUser = await prisma.user.upsert({
          where: { githubId },
          create: { ...fields, githubLogin },
          update: { ...profileFields, githubLogin },
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
