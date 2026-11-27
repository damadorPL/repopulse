import { createRequire } from "node:module";

import pino, { type DestinationStream, type Logger as PinoLogger, type LoggerOptions } from "pino";

export interface ServiceLogger {
  info(message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(message: string, error?: unknown): void;
  error(context: Record<string, unknown>, message: string): void;
  child(bindings: Record<string, unknown>): ServiceLogger;
}

export interface CreateLoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

function resolveLogLevel(override?: string): string {
  return override ?? process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");
}

function resolvePrettyTransport(): LoggerOptions["transport"] | undefined {
  if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test" || !process.stdout.isTTY) {
    return undefined;
  }
  try {
    const require = createRequire(import.meta.url);
    require.resolve("pino-pretty");
    return {
      target: "pino-pretty",
      options: { colorize: true, ignore: "pid,hostname" },
    };
  } catch {
    return undefined;
  }
}

function wrapPino(instance: PinoLogger): ServiceLogger {
  const logWithContext =
    (method: "info" | "warn") =>
    (arg1: string | Record<string, unknown>, arg2?: string): void => {
      if (typeof arg1 === "string") {
        instance[method](arg1);
      } else {
        instance[method](arg1, arg2 ?? "");
      }
    };

  const error = (arg1: string | Record<string, unknown>, arg2?: unknown): void => {
    if (typeof arg1 === "string") {
      if (arg2 === undefined) {
        instance.error(arg1);
      } else {
        instance.error({ err: arg2 }, arg1);
      }
    } else {
      instance.error(arg1, typeof arg2 === "string" ? arg2 : "");
    }
  };

  return {
    info: logWithContext("info"),
    warn: logWithContext("warn"),
    error,
    child: (bindings) => wrapPino(instance.child(bindings)),
  };
}

/**
 * Creates a structured Pino logger scoped to `service`, emitting JSON lines in production
 * and `pino-pretty` output in non-production TTY environments when `pino-pretty` is available.
 */
export function createLogger(service: string, options: CreateLoggerOptions = {}): ServiceLogger {
  const transport = options.destination ? undefined : resolvePrettyTransport();
  const pinoOptions: LoggerOptions = {
    level: resolveLogLevel(options.level),
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(transport ? { transport } : {}),
  };

  const instance = options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
  return wrapPino(instance);
}

export const log = createLogger("deps-sandbox");
