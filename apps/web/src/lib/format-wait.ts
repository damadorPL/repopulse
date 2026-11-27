/** Formats a cooldown duration in seconds as e.g. `4m 12s` or `45s`. */
export function formatWait(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest.toString().padStart(2, "0")}s` : `${rest}s`;
}
