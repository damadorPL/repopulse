import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth";
import { INVITE_COOKIE, INVITE_COOKIE_MAX_AGE_SECONDS } from "@/lib/invites";
import { findUsableInvite } from "@/server/registration";

export const metadata: Metadata = { title: "Invitation · RepoPulse", robots: { index: false } };

const mainStyle: CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  minHeight: "100dvh",
  display: "grid",
  placeItems: "center",
  padding: "2rem",
};
const buttonStyle: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.75rem 1rem",
  borderRadius: 8,
  border: "none",
  background: "#111827",
  color: "#fff",
  fontSize: 16,
  cursor: "pointer",
  textDecoration: "none",
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [session, invite] = await Promise.all([auth(), findUsableInvite(token)]);

  async function acceptInvite() {
    "use server";
    // Re-check at submit time; the sign-in callback claims the invite atomically anyway.
    if (!(await findUsableInvite(token))) redirect(`/invite/${encodeURIComponent(token)}`);
    (await cookies()).set(INVITE_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: INVITE_COOKIE_MAX_AGE_SECONDS,
    });
    await signIn("github", { redirectTo: "/" });
  }

  const inviter = invite ? (invite.createdBy.name ?? invite.createdBy.email) : null;

  return (
    <main style={mainStyle}>
      <section style={{ width: "100%", maxWidth: 380, textAlign: "center" }}>
        <h1 style={{ marginBottom: "0.25rem" }}>RepoPulse</h1>

        {session?.user?.id ? (
          <>
            <p style={{ color: "#6b7280", marginTop: 0 }}>You&apos;re already signed in, so you don&apos;t need this invite.</p>
            <Link href="/" style={buttonStyle}>
              Open RepoPulse
            </Link>
          </>
        ) : invite ? (
          <>
            <p style={{ color: "#6b7280", marginTop: 0 }}>
              {inviter} invited you to track GitHub releases on RepoPulse.
            </p>
            <form action={acceptInvite}>
              <button type="submit" style={buttonStyle}>
                Accept with GitHub
              </button>
            </form>
            <p style={{ color: "#9ca3af", fontSize: 12 }}>
              This link works once and expires on {invite.expiresAt.toISOString().slice(0, 10)}. Requests <code>read:user</code> and{" "}
              <code>user:email</code>.
            </p>
          </>
        ) : (
          <>
            <p
              role="alert"
              style={{
                background: "#fef2f2",
                color: "#991b1b",
                border: "1px solid #fecaca",
                borderRadius: 8,
                padding: "0.75rem",
                fontSize: 14,
              }}
            >
              This invite link is invalid, has already been used, or has expired. Ask for a new one.
            </p>
            <Link href="/login" style={{ color: "#6b7280", fontSize: 14 }}>
              Already have an account? Sign in
            </Link>
          </>
        )}
      </section>
    </main>
  );
}
