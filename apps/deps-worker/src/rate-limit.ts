const MIN_RATE_LIMIT_DELAY_MS = 5_000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;
const MAX_RATE_LIMIT_DELAY_MS = 60 * 60_000;

/**
 * How long to pause a queue after a GitHub rate-limit response: until the reset plus 1 s of clock-skew margin,
 * clamped to [5 s, 1 h]; a minute without a reset header. Same rule as `apps/worker` (`fan-out.ts`).
 */
export function rateLimitDelayMs(resetAt: Date | null, now: Date): number {
  const raw = resetAt ? resetAt.getTime() - now.getTime() + 1_000 : DEFAULT_RATE_LIMIT_DELAY_MS;
  return Math.min(Math.max(raw, MIN_RATE_LIMIT_DELAY_MS), MAX_RATE_LIMIT_DELAY_MS);
}
