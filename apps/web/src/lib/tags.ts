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

/** Black or white text, whichever reads better on `hex` (WCAG relative luminance). */
export function readableTextColor(hex: string): "#000000" | "#FFFFFF" {
  if (!isHexColor(hex)) return "#FFFFFF";
  const channel = (offset: number) => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.4 ? "#000000" : "#FFFFFF";
}
