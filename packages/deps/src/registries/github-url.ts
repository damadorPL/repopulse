/**
 * Normalizes repository URLs from registry metadata to `https://github.com/<owner>/<repo>`, or `null` when the
 * URL is not a GitHub repository. Accepts `git+https://…git`, `git://`, `git@github.com:o/r.git`, `github:o/r`,
 * npm shorthand `o/r`, deep links (`/tree/main/packages/x`).
 */
export function toGitHubRepoUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (value === "") return null;
  const shorthand = /^(?:github:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(value);
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  value = value.replace(/^git\+/, "").replace(/^git@github\.com:/i, "https://github.com/").replace(/^git:\/\//, "https://");
  value = value.replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/");
  const match = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(value);
  if (!match) return null;
  const owner = match[1] as string;
  const repo = match[2] as string;
  if (repo === "" || repo === "." || repo === "..") return null;
  return `https://github.com/${owner}/${repo}`;
}
