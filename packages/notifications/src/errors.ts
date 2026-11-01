/**
 * A delivery that failed. Messages are safe to show to the user and to log: they never contain
 * the full destination URL (webhook URLs carry secrets).
 *
 * `permanent` = retrying cannot help (bad URL, blocked address, 4xx, SMTP not configured), so the
 * worker fails the job without further attempts. Timeouts, network errors, 429 and 5xx are transient.
 */
export class NotificationDeliveryError extends Error {
  readonly permanent: boolean;
  readonly status: number | undefined;

  constructor(message: string, options: { permanent: boolean; status?: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NotificationDeliveryError";
    this.permanent = options.permanent;
    this.status = options.status;
  }
}

/** The destination URL is malformed or points at a blocked (private, loopback, metadata) address. */
export class WebhookUrlError extends NotificationDeliveryError {
  constructor(message: string, cause?: unknown) {
    super(message, { permanent: true, cause });
    this.name = "WebhookUrlError";
  }
}

export function isNotificationDeliveryError(error: unknown): error is NotificationDeliveryError {
  return error instanceof NotificationDeliveryError;
}
