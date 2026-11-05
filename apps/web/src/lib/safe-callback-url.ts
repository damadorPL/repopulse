/** Only allow same-origin relative paths as a post-login destination. */
export function safeCallbackUrl(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  try {
    const parsed = new URL(value, "http://repopulse.local");
    return parsed.origin === "http://repopulse.local" ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/";
  } catch {
    return "/";
  }
}
