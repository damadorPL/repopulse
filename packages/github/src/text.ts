/** Pure, browser-safe string helpers shared across `@repopulse/github`. */

/** Trims all trailing occurrences of `char` (single character) without regex backtracking. */
export function trimTrailingChar(value: string, char: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === char) end--;
  return end === value.length ? value : value.slice(0, end);
}

/** Trims all leading and trailing occurrences of `char` (single character) without regex backtracking. */
export function trimChar(value: string, char: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charAt(start) === char) start++;
  while (end > start && value.charAt(end - 1) === char) end--;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}
