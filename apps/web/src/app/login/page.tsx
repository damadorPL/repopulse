import type { Metadata, Route } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { SubmitButton } from "@/components/ui/submit-button";
import { auth } from "@/lib/auth";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import { isPublicRegistrationOpen } from "@/server/registration";

export const metadata: Metadata = { title: "Sign in · RepoPulse" };

const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied: "Access was denied. Please authorize the RepoPulse GitHub app to continue.",
  access_denied: "Access was denied. Please authorize the RepoPulse GitHub app to continue.",
  Configuration: "Sign-in is misconfigured on the server. Check the AUTH_* environment variables and database.",
  Verification: "The sign-in link is no longer valid.",
  InviteRequired: "RepoPulse is invite-only. Ask the super admin for an invite link to create an account.",
  InviteInvalid: "That invite link is invalid, has already been used, or has expired. Ask for a new one.",
};

type SearchParams = Promise<{ callbackUrl?: string | string[]; error?: string | string[] }>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const redirectTo = safeCallbackUrl(first(params.callbackUrl));
  const errorCode = first(params.error);

  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (session?.user.id) {
    redirect(redirectTo);
  }
  const publicRegistration = await isPublicRegistrationOpen();

  async function signInWithGitHub() {
    "use server";
    const result = await auth.api.signInSocial({
      body: {
        provider: "github",
        callbackURL: redirectTo,
        errorCallbackURL: "/login",
      },
      headers: await headers(),
    });
    if (result.url) {
      redirect(result.url as Route);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-8 text-foreground">
      <section className="grid w-full max-w-sm gap-4 rounded-lg border border-border bg-card p-6 text-center text-card-foreground shadow-xs">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">RepoPulse</h1>
          <p className="text-sm text-muted-foreground">Track GitHub releases you care about.</p>
        </div>

        {errorCode ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {ERROR_MESSAGES[errorCode] ?? "Sign-in failed. Please try again."}
          </p>
        ) : null}

        <form action={signInWithGitHub}>
          <SubmitButton size="lg" className="w-full" pendingLabel="Signing in…">
            Sign in with GitHub
          </SubmitButton>
        </form>
        {!publicRegistration ? (
          <p className="text-[13px] text-muted-foreground">
            New accounts are invite-only. Existing members can sign in as usual.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Requests <code>read:user</code> and <code>user:email</code>. Your token is stored encrypted.
        </p>
      </section>
    </main>
  );
}
