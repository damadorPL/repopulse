import { createLogger } from "@repopulse/queue";

export {
  createLogger,
  errorMessage,
  type CreateLoggerOptions,
  type ServiceLogger,
  type ServiceLogger as Logger,
} from "@repopulse/queue";

export const log = createLogger("worker");
