import type { Route } from "next";

/** Converts a runtime-constructed same-origin path string to Next.js's `Route` type when `typedRoutes` is enabled. */
export function toRoute(href: string): Route {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Next.js typedRoutes requires a Route cast for dynamic URLs
  return href as Route;
}
