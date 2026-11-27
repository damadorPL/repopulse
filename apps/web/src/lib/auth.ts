import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";
import { betterAuth, APIError } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { cookies, headers } from "next/headers";
import { encryptToken, prisma, type Prisma, type User as DbUser } from "@repopulse/db";
import { INVITE_COOKIE } from "@/lib/invites";
import { admitNewGitHubUser } from "@/server/registration";

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

const txStorage = new AsyncLocalStorage<Prisma.TransactionClient>();
const pendingClaimedInvites = new WeakMap<object, string>();
const pendingAccountTokenUpdates = new WeakMap<object, string>();

const prismaWithTxTracking = new Proxy(prisma, {
  get(target, prop) {
    if (prop === "$transaction") {
      return (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: Parameters<typeof prisma.$transaction>[1],
      ) => target.$transaction((tx) => txStorage.run(tx, () => fn(tx)), options);
    }
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

function resolveBaseUrl(): string | undefined {
  return process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? process.env.BETTER_AUTH_URL ?? undefined;
}

function resolveTrustedOrigins(): string[] {
  const candidates = [
    process.env.AUTH_URL,
    process.env.NEXTAUTH_URL,
    process.env.BETTER_AUTH_URL,
    process.env.APP_BASE_URL,
  ];
  const origins = new Set<string>();
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      origins.add(new URL(raw).origin);
    } catch {
      // Ignore malformed env values; Better Auth will still derive from the request if needed.
    }
  }
  return [...origins];
}

async function readInviteCookieSafely(): Promise<{
  token: string | undefined;
  cookieStore: Awaited<ReturnType<typeof cookies>> | null;
}> {
  try {
    const cookieStore = await cookies();
    return { token: cookieStore.get(INVITE_COOKIE)?.value, cookieStore };
  } catch {
    return { token: undefined, cookieStore: null };
  }
}

function resolveSecret(): string | undefined {
  const configured = process.env.AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET;
  if (configured) return configured;
  // Next.js sets NEXT_PHASE=phase-production-build during `next build` (e.g. Docker builds before runtime secrets exist).
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return "repopulse-build-placeholder-secret-not-used-at-runtime";
  }
  return undefined;
}

function createAuth() {
  const trustedOrigins = resolveTrustedOrigins();

  return betterAuth({
    secret: resolveSecret(),
    baseURL: resolveBaseUrl(),
    basePath: "/api/auth",
    ...(trustedOrigins.length > 0 ? { trustedOrigins } : {}),
    advanced: {
      trustedProxyHeaders: true,
    },
    onAPIError: {
      errorURL: "/login",
    },
    database: prismaAdapter(prismaWithTxTracking, {
      provider: "postgresql",
      transaction: true,
    }),
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 30,
      },
    },
    user: {
      fields: {
        image: "avatarUrl",
      },
      additionalFields: {
        githubId: { type: "string", required: false },
        githubLogin: { type: "string", required: false },
        isSuperAdmin: { type: "boolean", required: false, defaultValue: false, input: false },
      },
    },
    socialProviders: {
      github: {
        clientId: process.env.AUTH_GITHUB_ID ?? "",
        clientSecret: process.env.AUTH_GITHUB_SECRET ?? "",
        disableDefaultScope: true,
        scope: ["read:user", "user:email"],
        overrideUserInfoOnSignIn: true,
        mapProfileToUser(profile) {
          const githubId = String(profile.id);
          const githubLogin = typeof profile.login === "string" && profile.login.length > 0 ? profile.login : null;
          return {
            githubId,
            githubLogin,
            name: profile.name || profile.login || "",
            email: profile.email ?? `${githubId}+${githubLogin ?? "user"}@users.noreply.github.com`,
            image: profile.avatar_url || undefined,
          };
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          async before(_user, context) {
            const { token: inviteToken, cookieStore } = await readInviteCookieSafely();
            const decision = await admitNewGitHubUser(inviteToken, txStorage.getStore());
            if (!decision.admitted) {
              throw new APIError("FORBIDDEN", {
                code: decision.errorCode,
                message: decision.errorCode,
              });
            }
            if (cookieStore) {
              // Single-use either way; best effort, since the cookie expires within the hour anyway.
              try {
                cookieStore.delete(INVITE_COOKIE);
              } catch {
                // Cookie writes may be unavailable here; the short-lived cookie expires itself.
              }
            }
            if (decision.claimedInviteTokenHash && context) {
              pendingClaimedInvites.set(context, decision.claimedInviteTokenHash);
            }
            if (decision.isSuperAdmin) {
              return { data: { isSuperAdmin: true } };
            }
          },
        },
      },
      account: {
        create: {
          async before(account, context) {
            const db = txStorage.getStore() ?? prisma;
            if (context) {
              const claimedTokenHash = pendingClaimedInvites.get(context);
              if (claimedTokenHash) {
                pendingClaimedInvites.delete(context);
                await db.invite.update({
                  where: { tokenHash: claimedTokenHash },
                  data: { usedById: account.userId },
                });
              }
            }
            if (
              account.providerId === "github" &&
              typeof account.accessToken === "string" &&
              account.accessToken.length > 0
            ) {
              const githubAccessTokenEncrypted = encryptToken(account.accessToken);
              await db.user.update({
                where: { id: account.userId },
                data: { githubAccessTokenEncrypted },
              });
            }
            // Never persist plaintext OAuth tokens on Account; RepoPulse stores only the AES-256-GCM encrypted token on User.
            return {
              data: {
                accessToken: null,
                refreshToken: null,
                idToken: null,
              },
            };
          },
        },
        update: {
          async before(account, context) {
            if (typeof account.accessToken === "string" && account.accessToken.length > 0 && context) {
              pendingAccountTokenUpdates.set(context, encryptToken(account.accessToken));
            }
            return {
              data: {
                accessToken: null,
                refreshToken: null,
                idToken: null,
              },
            };
          },
          async after(account, context) {
            if (account.providerId === "github" && context) {
              const encrypted = pendingAccountTokenUpdates.get(context);
              if (encrypted) {
                pendingAccountTokenUpdates.delete(context);
                const db = txStorage.getStore() ?? prisma;
                await db.user.update({
                  where: { id: account.userId },
                  data: { githubAccessTokenEncrypted: encrypted },
                });
              }
            }
          },
        },
      },
    },
    plugins: [nextCookies()],
  });
}

type BetterAuthInstance = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { betterAuthInstance?: BetterAuthInstance };

function getAuth(): BetterAuthInstance {
  if (!globalForAuth.betterAuthInstance) {
    globalForAuth.betterAuthInstance = createAuth();
  }
  return globalForAuth.betterAuthInstance;
}

/**
 * Better Auth instance — GitHub OAuth with database-backed sessions.
 *
 * Lazily initialized on first access so Next.js build-time module evaluation
 * does not fail when runtime secrets (`AUTH_SECRET`) are not present yet.
 *
 * Env: `AUTH_SECRET` / `BETTER_AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`,
 * and `AUTH_URL` / `NEXTAUTH_URL` / `BETTER_AUTH_URL`.
 */
export const auth: BetterAuthInstance = new Proxy({} as BetterAuthInstance, {
  get(_target, prop) {
    if (prop === "then" || prop === "__esModule" || typeof prop === "symbol") {
      return undefined;
    }
    const instance = getAuth();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
  has(_target, prop) {
    if (prop === "then" || prop === "__esModule" || typeof prop === "symbol") {
      return false;
    }
    return prop in getAuth();
  },
});

/**
 * Returns the signed-in user's DB row from the Better Auth session without a second `User` query.
 * Memoized per request so multiple callers in one render/action share one session lookup.
 * Encrypted GitHub OAuth tokens are loaded lazily via `loadGitHubToken()` only when needed.
 */
export const getCurrentUserOrThrow = cache(async (): Promise<DbUser> => {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  const sessionUser = session?.user;
  if (!sessionUser?.id) {
    throw new UnauthorizedError();
  }
  return {
    id: sessionUser.id,
    email: sessionUser.email,
    emailVerified: Boolean(sessionUser.emailVerified),
    name: sessionUser.name ?? null,
    avatarUrl: sessionUser.image ?? null,
    githubId: String(sessionUser.githubId ?? ""),
    githubLogin: sessionUser.githubLogin ?? null,
    isSuperAdmin: Boolean(sessionUser.isSuperAdmin),
    githubAccessTokenEncrypted: null,
    createdAt: sessionUser.createdAt instanceof Date ? sessionUser.createdAt : new Date(sessionUser.createdAt),
    updatedAt: sessionUser.updatedAt instanceof Date ? sessionUser.updatedAt : new Date(sessionUser.updatedAt),
  };
});
