/** Result of bumping a declared range to admit a target version (npm and PEP 440 alike). */
export type BumpResult =
  /** The new declared spec, same operator style. */
  | { outcome: "bumped"; declared: string }
  /** The declared spec already admits the target and has no lower bound to move (`*`, `<3`, `||` ranges). */
  | { outcome: "unchanged" }
  /** An upper bound, exclusion or compound range rejects the target → `BLOCKED_BY_RANGE`. */
  | { outcome: "blocked" };
