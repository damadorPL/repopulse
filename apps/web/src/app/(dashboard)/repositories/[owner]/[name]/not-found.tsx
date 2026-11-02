import { NotTrackedState } from "@/components/repositories/not-tracked-state";
import { getDashboardData } from "@/server/queries/feed";
import { requireUser } from "@/server/session";

/**
 * `/repositories/<owner>/<name>` for a repository the signed-in user does not track (unknown, never
 * added, or only tracked by someone else): offers to add it. Not-found files get no params, so the
 * slug is read on the client.
 */
export default async function RepositoryNotTracked() {
  const user = await requireUser();
  const dashboard = await getDashboardData(user.id);
  const tags = dashboard.tags.map(({ id, name, slug, colorHex }) => ({ id, name, slug, colorHex }));
  return <NotTrackedState tags={tags} />;
}
