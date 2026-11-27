import { UnrecoverableError, type Job } from "bullmq";
import {
  loadDepsEnabled,
  loadSmtpSettings,
  SmtpPasswordUnreadableError,
  type DecryptedSmtpSettings,
  type PrismaClient,
} from "@repopulse/db";
import { parseTarget } from "@repopulse/deps";
import {
  dispatchDependencyNotification,
  isDeliverableChannel,
  NotificationDeliveryError,
  resolveAppBaseUrl,
  toSmtpConfig,
  type DependencyUpdateInput,
} from "@repopulse/notifications";
import { DEPS_QUEUE_NAMES, type DepsNotifyJobData } from "@repopulse/queue";
import { createLogger } from "../logger.js";
import { passesDependencyNotificationLevel } from "./notify-jobs.js";

const log = createLogger("deps-notify");

export type DepsNotifySkipReason =
  | "DISABLED"
  | "RULE_GONE"
  | "RULE_DISABLED"
  | "EVENT_DISABLED"
  | "TAG_SCOPED"
  | "UNSUPPORTED_CHANNEL"
  | "PROJECT_GONE"
  | "NOTIFICATION_LEVEL"
  | "MODE_CHANGED"
  | "PULL_REQUEST_GONE"
  | "NOTHING_LEFT";

export type DepsNotifyOutcome =
  | { status: "SKIPPED"; reason: DepsNotifySkipReason }
  | { status: "SENT"; channel: string; destination: string };

export interface DepsNotifyDeps {
  prisma: PrismaClient;
  /** Injected in tests. */
  dispatch?: typeof dispatchDependencyNotification;
  loadDepsEnabled?: () => Promise<boolean>;
  loadSmtp?: () => Promise<DecryptedSmtpSettings | null>;
  appBaseUrl?: string;
  signal?: AbortSignal;
}

/**
 * `deps-notify` job (Slice 08 §3.11.4): re-checks that the rule still exists, is enabled, covers the event and has
 * no tag, that the project still exists and its level / mode still allow it, then dispatches over the rule's
 * channel. Error classification like `notification-dispatch`: permanent → `UnrecoverableError`, else retried.
 */
export async function processDepsNotify(job: Job<DepsNotifyJobData>, deps: DepsNotifyDeps): Promise<DepsNotifyOutcome> {
  const data = job.data;
  const { prisma } = deps;
  const ctx = {
    queue: DEPS_QUEUE_NAMES.notify,
    jobId: job.id,
    ruleId: data.ruleId,
    projectId: data.projectId,
    kind: data.kind,
  };
  const skip = (reason: DepsNotifySkipReason): DepsNotifyOutcome => {
    log.info({ ...ctx, reason }, `rule ${data.ruleId} / project ${data.projectId} (${data.kind}): skipped (${reason})`);
    return { status: "SKIPPED", reason };
  };
  const enabled = deps.loadDepsEnabled ? await deps.loadDepsEnabled() : await loadDepsEnabled(prisma);
  if (!enabled) return skip("DISABLED");

  const [rule, project] = await Promise.all([
    prisma.notificationRule.findUnique({
      where: { id: data.ruleId },
      select: { id: true, userId: true, tagId: true, channel: true, destinationUrl: true, enabled: true, events: true },
    }),
    prisma.dependencyProject.findUnique({
      where: { id: data.projectId },
      select: {
        id: true,
        userId: true,
        fullName: true,
        owner: true,
        name: true,
        notificationLevel: true,
        updateMode: true,
      },
    }),
  ]);
  if (!project) return skip("PROJECT_GONE");
  if (!rule || rule.userId !== project.userId) return skip("RULE_GONE");
  if (!rule.enabled) return skip("RULE_DISABLED");
  if (!rule.events.includes(data.kind === "digest" ? "DEPENDENCY_UPDATES" : "DEPENDENCY_PULL_REQUESTS"))
    return skip("EVENT_DISABLED");
  if (rule.tagId !== null) return skip("TAG_SCOPED");
  if (!isDeliverableChannel(rule.channel)) return skip("UNSUPPORTED_CHANNEL");
  if (project.notificationLevel === "NONE") return skip("NOTIFICATION_LEVEL");

  let updates: DependencyUpdateInput[];
  let pullRequest: {
    event: "opened" | "updated" | "edited" | "access_lost";
    number: number | null;
    url: string | null;
  } | null = null;

  if (data.kind === "digest") {
    const [manifests, rows] = await Promise.all([
      prisma.dependencyManifest.findMany({
        where: { projectId: project.id },
        select: { id: true, path: true, ecosystem: true },
      }),
      prisma.dependencyUpdate.findMany({
        where: { projectId: project.id, id: { in: data.updateIds }, status: "OUTDATED" },
        select: { manifestId: true, name: true, currentVersion: true, targetVersion: true, level: true },
      }),
    ]);
    const manifestById = new Map(manifests.map((m) => [m.id, m]));
    updates = rows
      .filter((row) => row.targetVersion && passesDependencyNotificationLevel(project.notificationLevel, row.level))
      .flatMap((row) => {
        const manifest = manifestById.get(row.manifestId);
        return manifest
          ? [
              {
                name: row.name,
                from: row.currentVersion,
                to: row.targetVersion!,
                level: row.level,
                manifest: manifest.path,
                ecosystem: manifest.ecosystem,
              },
            ]
          : [];
      });
    if (updates.length === 0) return skip("NOTHING_LEFT");
  } else {
    if (data.event !== "access_lost" && project.updateMode === "NOTIFY") return skip("MODE_CHANGED");
    const pr = await prisma.dependencyPullRequest.findUnique({
      where: { id: data.prId },
      select: { number: true, htmlUrl: true, targets: true },
    });
    if (!pr && data.event !== "access_lost") return skip("PULL_REQUEST_GONE");
    updates = [];
    if (pr && pr.targets.length > 0) {
      const parsedTargets = pr.targets.flatMap((target) => {
        const parsed = parseTarget(target);
        return parsed ? [parsed] : [];
      });
      const targetNames = [...new Set(parsedTargets.map((t) => t.name))];
      const [manifests, rows] = await Promise.all([
        prisma.dependencyManifest.findMany({
          where: { projectId: project.id },
          select: { id: true, path: true, ecosystem: true },
        }),
        targetNames.length > 0
          ? prisma.dependencyUpdate.findMany({
              where: { projectId: project.id, name: { in: targetNames } },
              select: { manifestId: true, name: true, currentVersion: true, level: true },
            })
          : [],
      ]);
      const manifestByPath = new Map(manifests.map((m) => [m.path, m]));
      const rowByManifestAndName = new Map(rows.map((r) => [`${r.manifestId}\0${r.name}`, r]));
      for (const parsed of parsedTargets) {
        const manifest = manifestByPath.get(parsed.manifestPath);
        const row = manifest ? rowByManifestAndName.get(`${manifest.id}\0${parsed.name}`) : undefined;
        updates.push({
          name: parsed.name,
          from: row?.currentVersion ?? null,
          to: parsed.version,
          level: row?.level ?? null,
          manifest: parsed.manifestPath,
          ...(manifest ? { ecosystem: manifest.ecosystem } : {}),
        });
      }
    }
    pullRequest = { event: data.event, number: pr?.number ?? null, url: pr?.htmlUrl ?? null };
  }

  const needsUserEmail = rule.channel === "EMAIL_INSTANT" && !rule.destinationUrl?.trim();
  const user = needsUserEmail
    ? await prisma.user.findUnique({ where: { id: project.userId }, select: { email: true, name: true } })
    : null;
  const appBaseUrl = (deps.appBaseUrl ?? resolveAppBaseUrl()).replace(/\/+$/, "");
  const dispatch = deps.dispatch ?? dispatchDependencyNotification;
  const label = `${project.fullName} ${data.kind}${pullRequest ? ` (${pullRequest.event})` : ""} via ${rule.channel} (rule ${rule.id})`;
  try {
    const smtp = rule.channel === "EMAIL_INSTANT" ? toSmtpConfig(await loadSmtp(prisma, deps.loadSmtp)) : null;
    const result = await dispatch(
      {
        project: {
          fullName: project.fullName,
          url: `${appBaseUrl}/dependencies/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}`,
          htmlUrl: `https://github.com/${project.fullName}`,
        },
        kind: data.kind,
        updates,
        pullRequest,
        rule: { id: rule.id, channel: rule.channel, destinationUrl: rule.destinationUrl },
        user: user ? { email: user.email, name: user.name } : null,
      },
      { smtp, appBaseUrl, ...(deps.signal ? { signal: deps.signal } : {}) },
    );
    log.info(
      {
        ...ctx,
        channel: result.channel,
        destination: result.destination,
        ...(result.status ? { status: result.status } : {}),
      },
      `${label}: delivered to ${result.destination}${result.status ? ` (HTTP ${result.status})` : ""}`,
    );
    return { status: "SENT", channel: result.channel, destination: result.destination };
  } catch (error) {
    if (error instanceof NotificationDeliveryError && error.permanent) {
      log.warn({ ...ctx, err: error }, `${label}: permanent failure, not retrying: ${error.message}`);
      throw new UnrecoverableError(error.message);
    }
    log.warn(
      { ...ctx, attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1, err: error },
      `${label}: attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

/** A stored password that can't be decrypted won't fix itself on retry. */
async function loadSmtp(prisma: PrismaClient, loader?: () => Promise<DecryptedSmtpSettings | null>) {
  try {
    return await (loader ? loader() : loadSmtpSettings(prisma));
  } catch (error) {
    if (error instanceof SmtpPasswordUnreadableError)
      throw new NotificationDeliveryError(error.message, { permanent: true, cause: error });
    throw error;
  }
}
