import type { Metadata, Route } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { auth } from "@/lib/auth";
import { INVITE_COOKIE, INVITE_COOKIE_MAX_AGE_SECONDS } from "@/lib/invites";
import { findUsableInvite } from "@/server/registration";

export const metadata: Metadata = { title: "Invitation · RepoPulse", robots: { index: false } };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const requestHeaders = await headers();
  const [session, invite] = await Promise.all([
    auth.api.getSession({ headers: requestHeaders }),
    findUsableInvite(token),
  ]);

  async function acceptInvite() {
    "use server";
    // Re-check at submit time; the registration gate claims the invite atomically anyway.
    if (!(await findUsableInvite(token))) redirect(`/invite/${encodeURIComponent(token)}`);
    (await cookies()).set(INVITE_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: INVITE_COOKIE_MAX_AGE_SECONDS,
    });
    const result = await auth.api.signInSocial({
      body: {
        provider: "github",
        callbackURL: "/",
        errorCallbackURL: "/login",
      },
      headers: await headers(),
    });
    if (result.url) {
      redirect(result.url as Route);
    }
  }

  const inviter = invite ? (invite.createdBy.name ?? invite.createdBy.email) : null;

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-8 text-foreground">
      <section className="grid w-full max-w-sm gap-4 rounded-lg border border-border bg-card p-6 text-center text-card-foreground shadow-xs">
        <h1 className="text-2xl font-semibold tracking-tight">RepoPulse</h1>

        {session?.user.id ? (
          <>
            <p className="text-sm text-muted-foreground">
              You&apos;re already signed in, so you don&apos;t need this invite.
            </p>
            <Button asChild size="lg" className="w-full">
              <Link href="/">Open RepoPulse</Link>
            </Button>
          </>
        ) : invite ? (
          <>
            <p className="text-sm text-muted-foreground">
              {inviter} invited you to track GitHub releases on RepoPulse.
            </p>
            <form action={acceptInvite}>
              <SubmitButton size="lg" className="w-full" pendingLabel="Accepting…">
                Accept with GitHub
              </SubmitButton>
            </form>
            <p className="text-xs text-muted-foreground">
              This link works once and expires on {invite.expiresAt.toISOString().slice(0, 10)}. Requests{" "}
              <code>read:user</code> and <code>user:email</code>.
            </p>
          </>
        ) : (
          <>
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
            >
              This invite link is invalid, has already been used, or has expired. Ask for a new one.
            </p>
            <Link
              href="/login"
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Already have an account? Sign in
            </Link>
          </>
        )}
      </section>
    </main>
  );
}
