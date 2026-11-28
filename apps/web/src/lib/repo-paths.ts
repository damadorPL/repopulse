import { commitMatchesPath } from "@repopulse/github/watched-paths";

/**
 * Helpers for the "Files / folders" path picker: index the repository tree returned by
 * `listRepositoryPathsAction`, rank autocomplete suggestions and list a folder's children.
 * Pure and browser-safe.
 */

export type RepoPathKind = "dir" | "file";

export interface RepoPathEntry {
  path: string;
  kind: RepoPathKind;
  /** Last path segment. */
  name: string;
}

export interface RepoPathIndex {
  entries: RepoPathEntry[];
  /** Children of each folder ("" is the repository root): folders first, then files, by name. */
  children: Map<string, RepoPathEntry[]>;
  kinds: Map<string, RepoPathKind>;
}

/** `packages/cli` → `packages`, `README.md` → `""`. */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function compareEntries(a: RepoPathEntry, b: RepoPathEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true });
}

export function buildRepoPathIndex(tree: { dirs: readonly string[]; files: readonly string[] }): RepoPathIndex {
  const entries: RepoPathEntry[] = [
    ...tree.dirs.map((path) => ({ path, kind: "dir" as const, name: baseName(path) })),
    ...tree.files.map((path) => ({ path, kind: "file" as const, name: baseName(path) })),
  ];
  const children = new Map<string, RepoPathEntry[]>();
  const kinds = new Map<string, RepoPathKind>();
  for (const entry of entries) {
    kinds.set(entry.path, entry.kind);
    const parent = parentOf(entry.path);
    const list = children.get(parent);
    if (list) list.push(entry);
    else children.set(parent, [entry]);
  }
  for (const list of children.values()) list.sort(compareEntries);
  return { entries, children, kinds };
}

/** The selected path that already covers `path` (the path itself or a parent folder), if any. */
export function coveringPath(path: string, selected: readonly string[]): string | null {
  return selected.find((watched) => commitMatchesPath(path, watched)) ?? null;
}

/** Adds `path` to `selected`, dropping selected paths inside it (a folder already matches them). */
export function addCoveringPath(selected: readonly string[], path: string): string[] {
  return [...selected.filter((watched) => !commitMatchesPath(watched, path)), path];
}

export interface PathSuggestion extends RepoPathEntry {
  /** Where the query matched, for highlighting (`-1` for an empty query). */
  matchStart: number;
}

/**
 * Ranks entries matching `query` (case-insensitive): exact path, path prefix (`packages/c`), name
 * prefix (`CHANGE`), segment prefix, then anywhere. Ties go to shallower paths, folders, then
 * shorter and alphabetical paths. An empty query lists the repository root.
 */
export function searchRepoPaths(index: RepoPathIndex, query: string, limit = 8): PathSuggestion[] {
  const q = query
    .trim()
    .replace(/^(\.\/|\/)+/, "")
    .toLowerCase();
  if (q === "") {
    return (index.children.get("") ?? [])
      .slice(0, limit)
      .map((entry) => ({ path: entry.path, kind: entry.kind, name: entry.name, matchStart: -1 }));
  }

  const scored: Array<{ entry: RepoPathEntry; score: number; matchStart: number; depth: number }> = [];
  for (const entry of index.entries) {
    const path = entry.path.toLowerCase();
    let score: number;
    let matchStart: number;
    if (path === q || `${path}/` === q) {
      score = 0;
      matchStart = 0;
    } else if (path.startsWith(q)) {
      score = 1;
      matchStart = 0;
    } else {
      const nameStart = path.length - entry.name.length;
      if (path.startsWith(q, nameStart)) {
        score = 2;
        matchStart = nameStart;
      } else {
        const segment = path.indexOf(`/${q}`);
        if (segment !== -1) {
          score = 3;
          matchStart = segment + 1;
        } else {
          matchStart = path.indexOf(q);
          if (matchStart === -1) continue;
          score = 4;
        }
      }
    }
    scored.push({ entry, score, matchStart, depth: entry.path.split("/").length });
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.depth - b.depth ||
      (a.entry.kind === b.entry.kind ? 0 : a.entry.kind === "dir" ? -1 : 1) ||
      a.entry.path.length - b.entry.path.length ||
      a.entry.path.localeCompare(b.entry.path),
  );
  return scored
    .slice(0, limit)
    .map(({ entry, matchStart }) => ({ path: entry.path, kind: entry.kind, name: entry.name, matchStart }));
}

/**
 * A cheap client-side check before asking GitHub for a tree: `owner/repo` or a github.com URL.
 * The Server Action parses the input properly.
 */
export function looksLikeRepository(input: string): boolean {
  return /^(https?:\/\/)?(www\.)?(github\.com\/)?[A-Za-z0-9-]+\/[A-Za-z0-9._-]+/.test(input.trim());
}

/** Extracts the repository name from slugs and GitHub URLs for the path browser root breadcrumb. */
export function rootLabel(repo: string | null): string {
  if (!repo) return "root";
  const trimmed = repo.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const segments = new URL(trimmed).pathname.split("/").filter(Boolean);
      return segments[1] ?? "root";
    } catch {
      return "root";
    }
  }
  const colon = trimmed.indexOf(":");
  const slug = colon !== -1 ? trimmed.slice(colon + 1) : trimmed;
  const segments = slug.split("/").filter(Boolean);
  const first = segments[0]?.toLowerCase();
  if (first === "github.com" || first === "www.github.com") {
    return segments[2] ?? "root";
  }
  return segments[1] ?? "root";
}

/**
 * For a parent Dialog/Popover's `onEscapeKeyDown`: Radix listens for Escape on the document in the
 * capture phase, before the picker sees it. Call `event.preventDefault()` when this returns true so
 * the first Escape only closes the suggestion list.
 */
export function isExpandedCombobox(target: EventTarget | null): boolean {
  const element = target as Partial<Element> | null;
  if (typeof element?.getAttribute !== "function") return false;
  return element.getAttribute("role") === "combobox" && element.getAttribute("aria-expanded") === "true";
}
