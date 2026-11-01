import { UnrecoverableError, type Job } from "bullmq";
import { loadSmtpSettings, SmtpPasswordUnreadableError, type PrismaClient } from "@repopulse/db";
import { dispatchNotification, isDeliverableChannel, NotificationDeliveryError, toSmtpConfig } from "@repopulse/notifications";
import type { NotificationJobData } from "@repopulse/queue";
import { createLogger } from "../logger";

const log = createLogger("notification-dispatch");

export type NotificationSkipReason =
  | "RULE_GONE"
  | "RULE_DISABLED"
  | "RELEASE_GONE"
  | "NOT_MAJOR"
  | "UNSUBSCRIBED"
  | "TAG_REMOVED"
  | "UNSUPPORTED_CHANNEL";

export type NotificationOutcome =
  | { status: "SKIPPED"; reason: NotificationSkipReason }
  | { status: "SENT"; channel: string; destination: string };

export interface NotificationDeps {
  prisma: PrismaClient;
  /** Injected in tests. */
  dispatch?: typeof dispatchNotification;
  signal?: AbortSignal;
}

/**
 * `notification-dispatch` job: `{ ruleId, releaseId, userId }`, queued by the repo-poll fan-out.
 *
 * The rule is re-checked here because it may have changed since the fan-out: disabled, deleted,
 * switched to major-only, or the user untracked the repository or removed the tag.
 *
 * Retries (`NOTIFICATION_JOB_OPTIONS`: 3 attempts, exponential from 5 s) are for transient
 * failures only. A permanent one (4xx, blocked URL, SMTP missing) throws `UnrecoverableError`,
 * which fails the job at once.
 *
 * Email rules read the SMTP settings (Settings → Email) on every job, so changes saved in the UI
 * apply without restarting the worker.
 */
export async function processNotification(job: Job<NotificationJobData>, deps: NotificationDeps): Promise<NotificationOutcome> {
  const { ruleId, releaseId, userId } = job.data;
  const skip = (reason: NotificationSkipReason): NotificationOutcome => {
    log.info(`rule ${ruleId} / release ${releaseId}: skipped (${reason})`);
    return { status: "SKIPPED", reason };
  };

  const [rule, release, user] = await Promise.all([
    deps.prisma.notificationRule.findUnique({
      where: { id: ruleId },
      select: {
        id: true,
        userId: true,
        tagId: true,
        channel: true,
        destinationUrl: true,
        onlyMajorReleases: true,
        enabled: true,
        tag: { select: { name: true, colorHex: true } },
      },
    }),
    deps.prisma.release.findUnique({
      where: { id: releaseId },
      select: {
        id: true,
        repositoryId: true,
        tagName: true,
        title: true,
        bodyMarkdown: true,
        htmlUrl: true,
        semverType: true,
        isPrerelease: true,
        publishedAt: true,
        source: true,
        repository: { select: { fullName: true, htmlUrl: true, avatarUrl: true } },
      },
    }),
    deps.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } }),
  ]);

  if (!rule || rule.userId !== userId || !user) return skip("RULE_GONE");
  if (!rule.enabled) return skip("RULE_DISABLED");
  if (!release) return skip("RELEASE_GONE");
  if (rule.onlyMajorReleases && release.semverType !== "MAJOR") return skip("NOT_MAJOR");
  if (!isDeliverableChannel(rule.channel)) return skip("UNSUPPORTED_CHANNEL");

  const subscription = await deps.prisma.userSubscription.findUnique({
    where: { userId_repositoryId: { userId, repositoryId: release.repositoryId } },
    select: { tags: { select: { tagId: true } } },
  });
  if (!subscription) return skip("UNSUBSCRIBED");
  if (rule.tagId && !subscription.tags.some((t) => t.tagId === rule.tagId)) return skip("TAG_REMOVED");

  const dispatch = deps.dispatch ?? dispatchNotification;
  const label = `${release.repository.fullName} ${release.tagName} via ${rule.channel} (rule ${ruleId})`;
  try {
    const smtp = rule.channel === "EMAIL_INSTANT" ? toSmtpConfig(await loadSmtp(deps.prisma)) : null;
    const result = await dispatch(
      { rule, release, repository: release.repository, user },
      { smtp, ...(deps.signal ? { signal: deps.signal } : {}) },
    );
    log.info(`${label}: delivered to ${result.destination}${result.status ? ` (HTTP ${result.status})` : ""}`);
    return { status: "SENT", channel: result.channel, destination: result.destination };
  } catch (error) {
    if (error instanceof NotificationDeliveryError && error.permanent) {
      log.warn(`${label}: permanent failure, not retrying: ${error.message}`);
      throw new UnrecoverableError(error.message);
    }
    const attempts = job.opts.attempts ?? 1;
    log.warn(`${label}: attempt ${job.attemptsMade + 1}/${attempts} failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/** A stored password that can't be decrypted won't fix itself on retry. */
async function loadSmtp(prisma: PrismaClient) {
  try {
    return await loadSmtpSettings(prisma);
  } catch (error) {
    if (error instanceof SmtpPasswordUnreadableError) {
      throw new NotificationDeliveryError(error.message, { permanent: true, cause: error });
    }
    throw error;
  }
}
