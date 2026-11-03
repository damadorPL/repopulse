import type { NextRequest } from "next/server";
import { GitHubAppKeyUnreadableError, loadDepsEnabled, loadGitHubAppSettings, prisma } from "@repopulse/db";
import { enqueueWebhookScan } from "@/server/deps-webhook-queue";
import { handleGitHubAppWebhook, type WebhookDeps } from "@/server/github-app-webhook";
import { RealtimeUnavailableError } from "@/server/realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/github-app/webhook: deliveries of the RepoPulse GitHub App (Slice 08 Part E). Public: no
 * session, authenticated by `X-Hub-Signature-256` (HMAC-SHA256 with the App's webhook secret). Body
 * capped at 5 MiB. Pushes to a project's default branch that touch a manifest or lockfile, and closed
 * `repopulse/deps/*` pull requests, enqueue a `deps-scan`; everything else answers 204. No database
 * writes. Polling stays the fallback, so a failed delivery only delays a scan.
 */
const deps: WebhookDeps = {
  async loadSettings() {
    const [app, depsEnabled] = await Promise.all([loadGitHubAppSettings(prisma), loadDepsEnabled(prisma)]);
    return { depsEnabled, app: app ? { webhookSecret: app.webhookSecret } : null };
  },
  findProjectsOnBranch: (githubRepoId, branch) =>
    prisma.dependencyProject.findMany({ where: { githubRepoId, defaultBranch: branch }, select: { id: true, manifestPaths: true } }),
  async findPrOwnerProjectId(githubRepoId) {
    const owner = await prisma.dependencyPrOwner.findUnique({ where: { githubRepoId }, select: { projectId: true } });
    return owner?.projectId ?? null;
  },
  enqueueScan: enqueueWebhookScan,
};

function respond(status: number, body?: Record<string, unknown>): Response {
  return body ? Response.json(body, { status }) : new Response(null, { status });
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const result = await handleGitHubAppWebhook({ headers: request.headers, body: request.body }, deps);
    return respond(result.status, result.body);
  } catch (error) {
    if (error instanceof GitHubAppKeyUnreadableError) {
      console.warn("[github-app-webhook] the stored webhook secret can't be decrypted (was TOKEN_ENCRYPTION_KEY changed?)");
      return respond(503, { error: "webhook secret unreadable" });
    }
    if (error instanceof RealtimeUnavailableError) {
      console.warn("[github-app-webhook] could not enqueue a scan: Redis is unavailable");
      return respond(503, { error: "queue unavailable" });
    }
    console.error("[github-app-webhook] delivery failed", error instanceof Error ? error.message : error);
    return respond(503, { error: "temporarily unavailable" });
  }
}
