/** Tag helpers shared by Server Actions and client forms. */

export const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
export const TAG_NAME_MAX_LENGTH = 40;
export const DEFAULT_TAG_COLOR = "#3B82F6";

/** Tailwind 500 shades — quick picks in the tag editor (any `#RRGGBB` is accepted). */
export const TAG_COLOR_PRESETS = [
  "#EF4444",
  "#F97316",
  "#F59E0B",
  "#84CC16",
  "#10B981",
  "#06B6D4",
  "#3B82F6",
  "#6366F1",
  "#8B5CF6",
  "#EC4899",
  "#64748B",
] as const;

/**
 * URL-safe slug: `Self-Hosted` → `self-hosted`, `UI Libraries` → `ui-libraries`,
 * `Café & Co.` → `cafe-co`. Returns "" when nothing slug-able remains.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/**
 * Slug for a tag name. Names without any Latin letters or digits (`Фронтенд`, `前端`, `🚀`)
 * fall back to a stable hash, so they still get a unique, URL-safe slug (and duplicates of the
 * same name still collide on the `(userId, slug)` unique index).
 */
export function tagSlug(name: string): string {
  const slug = slugify(name);
  if (slug) return slug;
  let hash = 0x811c9dc5; // FNV-1a, 32-bit
  for (const char of name.trim().normalize("NFKC").toLowerCase()) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  }
  return `tag-${hash.toString(36)}`;
}

export function isHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}
