import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@repopulse/db";
import { auth, signOut } from "@/lib/auth";
import { addRepositoryAction, removeSubscriptionAction } from "@/server/actions/repositories";

// Minimal signed-in shell for Slice 02 (the full panel UI arrives in Slice 03).

type SearchParams = Promise<{ added?: string; error?: string }>;

async function addRepository(formData: FormData) {
  "use server";
  const result = await addRepositoryAction({
    repoUrlOrSlug: String(formData.get("repo") ?? ""),
    includePrereleases: formData.get("includePrereleases") === "on",
    tagIds: [],
  });
  if (!result.ok && result.error.code === "UNAUTHORIZED") redirect("/login");
  redirect(
    result.ok
      ? `/?added=${encodeURIComponent(result.data.fullName)}`
      : `/?error=${encodeURIComponent(result.error.message)}`,
  );
}

async function removeSubscription(formData: FormData) {
  "use server";
  const result = await removeSubscriptionAction({ subscriptionId: String(formData.get("subscriptionId") ?? "") });
  if (!result.ok) redirect(`/?error=${encodeURIComponent(result.error.message)}`);
  redirect("/");
}

async function signOutAction() {
  "use server";
  await signOut({ redirectTo: "/login" });
}

export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return (
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <h1>RepoPulse</h1>
        <p>
          <Link href="/login">Sign in with GitHub</Link> to start tracking releases.
        </p>
      </main>
    );
  }

  const { added, error } = await searchParams;
  const subscriptions = await prisma.userSubscription.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { repository: { select: { fullName: true, htmlUrl: true, _count: { select: { releases: true } } } } },
  });

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 720 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>RepoPulse</h1>
        <form action={signOutAction} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span>{session.user?.name ?? session.user?.email}</span>
          <button type="submit">Sign out</button>
        </form>
      </header>

      {added ? <p role="status" style={{ color: "#047857" }}>Now tracking {added}.</p> : null}
      {error ? <p role="alert" style={{ color: "#b91c1c" }}>{error}</p> : null}

      <form action={addRepository} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "1.5rem 0" }}>
        <input
          name="repo"
          required
          placeholder="owner/repo or https://github.com/owner/repo"
          aria-label="Repository"
          style={{ flex: "1 1 280px", padding: "0.5rem" }}
        />
        <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" name="includePrereleases" /> Pre-releases
        </label>
        <button type="submit">Add repository</button>
      </form>

      {subscriptions.length === 0 ? (
        <p style={{ color: "#6b7280" }}>No repositories tracked yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {subscriptions.map((sub) => (
            <li
              key={sub.id}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "0.5rem 0", borderBottom: "1px solid #e5e7eb" }}
            >
              <span>
                <a href={sub.repository.htmlUrl} target="_blank" rel="noreferrer">
                  {sub.repository.fullName}
                </a>{" "}
                <small style={{ color: "#6b7280" }}>{sub.repository._count.releases} releases</small>
              </span>
              <form action={removeSubscription}>
                <input type="hidden" name="subscriptionId" value={sub.id} />
                <button type="submit">Remove</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
