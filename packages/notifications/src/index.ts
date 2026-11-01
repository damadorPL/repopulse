export {
  CHANNEL_INFO,
  DELIVERABLE_CHANNELS,
  channelLabel,
  isDeliverableChannel,
  maskDestination,
  type ChannelInfo,
  type DeliverableChannel,
} from "./channels.js";
export {
  buildTestRelease,
  dispatchNotification,
  releaseReaderUrl,
  resolveAppBaseUrl,
  type DispatchOptions,
  type DispatchResult,
} from "./dispatcher.js";
export { NotificationDeliveryError, WebhookUrlError, isNotificationDeliveryError } from "./errors.js";
export { formatCustomWebhookPayload, type CustomWebhookPayload } from "./formatters/custom.js";
export { DISCORD_COLORS, formatDiscordPayload, type DiscordWebhookPayload } from "./formatters/discord.js";
export {
  createSmtpSender,
  isSmtpConfigured,
  readSmtpConfig,
  renderReleaseEmail,
  type EmailMessage,
  type MailSender,
  type RenderedEmail,
  type SmtpConfig,
} from "./formatters/email.js";
export {
  buildGotifyRequest,
  buildNtfyRequest,
  formatGotifyMessage,
  resolveGotifyEndpoint,
  type GotifyMessage,
  type PreparedRequest,
} from "./formatters/ntfy-gotify.js";
export { formatSlackPayload, type SlackWebhookPayload } from "./formatters/slack.js";
export { postWebhook, type HttpOptions, type WebhookRequest, type WebhookResponse, type WebhookSender } from "./http.js";
export {
  classifyAddress,
  createGuardedLookup,
  internalHostsPolicyFromEnv,
  parseInternalHostsPolicy,
  validateWebhookUrl,
  type AddressClass,
  type InternalHostsPolicy,
  type ResolveAll,
  type ValidateWebhookUrlOptions,
} from "./ssrf-guard.js";
export type {
  DispatchInput,
  NotificationChannel,
  NotificationReleaseInput,
  NotificationRepositoryInput,
  NotificationRuleInput,
  NotificationUserInput,
  SemverType,
} from "./types.js";
