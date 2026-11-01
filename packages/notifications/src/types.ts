/**
 * Structural input types. They mirror the Prisma models (`@repopulse/db`) without depending on
 * them, so the worker and the web app can pass database rows directly and tests can pass literals.
 */

export type NotificationChannel =
  | "IN_APP"
  | "EMAIL_INSTANT"
  | "EMAIL_DIGEST"
  | "DISCORD_WEBHOOK"
  | "SLACK_WEBHOOK"
  | "NTFY_WEBHOOK"
  | "GOTIFY_WEBHOOK"
  | "CUSTOM_WEBHOOK";

export type SemverType = "MAJOR" | "MINOR" | "PATCH" | "PRERELEASE" | "OTHER";

export interface NotificationRuleInput {
  id: string;
  channel: NotificationChannel;
  /** Webhook URL, or for email an optional recipient address (default: the user's email). */
  destinationUrl: string | null;
  onlyMajorReleases?: boolean;
  /** The rule's tag scope; `null` = all repositories. */
  tag?: { name: string; colorHex: string } | null;
}

export interface NotificationReleaseInput {
  id: string;
  tagName: string;
  title: string;
  bodyMarkdown: string;
  htmlUrl: string;
  semverType: SemverType;
  isPrerelease: boolean;
  publishedAt: Date;
  /** `TAG` = a Git tag without a GitHub Release (Slice 04c); `COMMIT` = a commit touching a watched path (Slice 06). */
  source?: "RELEASE" | "TAG" | "COMMIT";
}

export interface NotificationRepositoryInput {
  fullName: string;
  htmlUrl: string;
  avatarUrl?: string | null;
}

export interface NotificationUserInput {
  id: string;
  email: string;
  name?: string | null;
}

export interface DispatchInput {
  rule: NotificationRuleInput;
  release: NotificationReleaseInput;
  repository: NotificationRepositoryInput;
  user: NotificationUserInput;
  /** Marks a "Send Test" delivery (custom webhooks receive `"test": true`). */
  test?: boolean;
  /** Overrides the "Open in RepoPulse" link (the test release has no reader page). */
  readerUrl?: string;
}

/** Links and labels every formatter needs, computed once by the dispatcher. */
export interface MessageContext extends DispatchInput {
  readerUrl: string;
  appBaseUrl: string;
}
