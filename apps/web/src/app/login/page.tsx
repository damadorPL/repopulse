import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import { isPublicRegistrationOpen } from "@/server/registration";

export const metadata: Metadata = { title: "Sign in · RepoPulse" };

const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied: "Access was denied. Please authorize the RepoPulse GitHub app to continue.",
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

  const session = await auth();
  if (session?.user?.id) {
    redirect(redirectTo);
  }
  const publicRegistration = await isPublicRegistrationOpen();

  async function signInWithGitHub() {
    "use server";
    await signIn("github", { redirectTo });
  }

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
      }}
    >
      <section style={{ width: "100%", maxWidth: 360, textAlign: "center" }}>
        <h1 style={{ marginBottom: "0.25rem" }}>RepoPulse</h1>
        <p style={{ color: "#6b7280", marginTop: 0 }}>Track GitHub releases you care about.</p>

        {errorCode ? (
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
            {ERROR_MESSAGES[errorCode] ?? "Sign-in failed. Please try again."}
          </p>
        ) : null}

        <form action={signInWithGitHub}>
          <button
            type="submit"
            style={{
              width: "100%",
              padding: "0.75rem 1rem",
              borderRadius: 8,
              border: "none",
              background: "#111827",
              color: "#fff",
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            Sign in with GitHub
          </button>
        </form>
        {!publicRegistration ? (
          <p style={{ color: "#6b7280", fontSize: 13 }}>New accounts are invite-only. Existing members can sign in as usual.</p>
        ) : null}
        <p style={{ color: "#9ca3af", fontSize: 12 }}>
          Requests <code>read:user</code> and <code>user:email</code>. Your token is stored encrypted.
        </p>
      </section>
    </main>
  );
}
