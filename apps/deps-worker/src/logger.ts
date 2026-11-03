export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/** Single-line, scope-prefixed console logger (`[repo-poll] ...`). */
export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  return {
    info: (message) => console.log(`${prefix} ${message}`),
    warn: (message) => console.warn(`${prefix} ${message}`),
    error: (message, error) =>
      console.error(error === undefined ? `${prefix} ${message}` : `${prefix} ${message}: ${errorMessage(error)}`),
  };
}
