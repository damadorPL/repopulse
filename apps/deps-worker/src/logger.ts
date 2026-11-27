import { createLogger } from "@repopulse/queue";

export { createLogger, type ServiceLogger } from "@repopulse/queue";

export const log = createLogger("deps-worker");
