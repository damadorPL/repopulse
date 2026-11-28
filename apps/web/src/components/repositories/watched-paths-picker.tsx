"use client";

import {
  ChevronRightIcon,
  CornerLeftUpIcon,
  FileIcon,
  FolderIcon,
  FolderTreeIcon,
  LoaderCircleIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import type { RepoTree } from "@repopulse/github";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  addCoveringPath,
  buildRepoPathIndex,
  coveringPath,
  looksLikeRepository,
  rootLabel,
  searchRepoPaths,
  type PathSuggestion,
  type RepoPathEntry,
  type RepoPathIndex,
  type RepoPathKind,
} from "@/lib/repo-paths";
import { cn } from "@/lib/utils";
import { MAX_WATCHED_PATHS, normalizeWatchedPath, WATCHED_PATHS_PLACEHOLDER } from "@/lib/watched-paths";
import { listRepositoryPathsAction, type ActionResult } from "@/server/actions/repositories";

const SUGGESTION_LIMIT = 8;
/** Rows rendered per folder in the browser; larger folders are searched instead. */
const BROWSER_ROW_LIMIT = 300;
const TREE_CACHE_TTL_MS = 5 * 60_000;

// ---- Repository tree loading -------------------------------------------------------------

const treeCache = new Map<string, { at: number; promise: Promise<ActionResult<RepoTree>> }>();

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === "/") end--;
  return end === value.length ? value : value.slice(0, end);
}

function treeKey(repo: string): string {
  return trimTrailingSlash(
    repo
      .trim()
      .toLowerCase()
      .replace(/\.git$/, ""),
  );
}

/** One request per repository per few minutes, shared by every picker on the page. Failures aren't cached. */
function loadTree(repo: string): Promise<ActionResult<RepoTree>> {
  const key = treeKey(repo);
  const cached = treeCache.get(key);
  if (cached && Date.now() - cached.at < TREE_CACHE_TTL_MS) return cached.promise;
  const promise = listRepositoryPathsAction({ repoUrlOrSlug: repo }).then(
    (result) => {
      if (!result.ok) treeCache.delete(key);
      return result;
    },
    (error: unknown) => {
      treeCache.delete(key);
      throw error;
    },
  );
  treeCache.set(key, { at: Date.now(), promise });
  return promise;
}

type TreeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; tree: RepoTree; index: RepoPathIndex }
  | { status: "error"; message: string };

function useRepoTree(repo: string | null, debounceMs: number): TreeState {
  const key = repo && looksLikeRepository(repo) ? treeKey(repo) : null;
  const [loaded, setLoaded] = useState<{ key: string; state: TreeState } | null>(null);

  useEffect(() => {
    if (!key || !repo) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await loadTree(repo);
          if (cancelled) return;
          setLoaded({
            key,
            state: result.ok
              ? { status: "ready", tree: result.data, index: buildRepoPathIndex(result.data) }
              : { status: "error", message: result.error.message },
          });
        } catch {
          if (!cancelled) setLoaded({ key, state: { status: "error", message: "Could not reach the server." } });
        }
      })();
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, repo, debounceMs]);

  if (!key) return { status: "idle" };
  return loaded?.key === key ? loaded.state : { status: "loading" };
}

// ---- Picker helpers & subcomponents ------------------------------------------------------

function KindIcon({ kind, className }: { kind: RepoPathKind | undefined; className?: string }) {
  const Icon = kind === "file" ? FileIcon : FolderIcon;
  return <Icon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} aria-hidden />;
}

function Highlighted({ text, start, length }: { text: string; start: number; length: number }) {
  if (start < 0 || length <= 0) return text;
  const end = Math.min(text.length, start + length);
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-[2px] bg-unread/20 text-foreground">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

type Option = { type: "entry"; suggestion: PathSuggestion; covered: string | null } | { type: "raw"; path: string };

/** Adds one path; returns an error message instead when it can't be added. */
function addWatchedPath(current: string[], raw: string): { paths: string[] } | { error: string } {
  const path = normalizeWatchedPath(raw);
  if (!path)
    return {
      error: `"${raw.trim()}" is not a valid path. Use a path relative to the repository root, like packages/cli.`,
    };
  const covering = coveringPath(path, current);
  if (covering) return { paths: current };
  const next = addCoveringPath(current, path);
  if (next.length > MAX_WATCHED_PATHS) return { error: `Watch at most ${MAX_WATCHED_PATHS} paths.` };
  return { paths: next };
}

function buildPathOptions(
  index: RepoPathIndex | null,
  query: string,
  normalizedDraft: string | null,
  paths: string[],
): Option[] {
  if (!index) return [];
  const entries: Option[] = searchRepoPaths(index, query, SUGGESTION_LIMIT).map((suggestion) => ({
    type: "entry",
    suggestion,
    covered: coveringPath(suggestion.path, paths),
  }));
  // Offer the typed text as-is when it isn't an exact match: a path not on the default branch yet.
  const exact = entries.some((option) => option.type === "entry" && option.suggestion.path === normalizedDraft);
  if (normalizedDraft && !exact && !coveringPath(normalizedDraft, paths)) {
    entries.push({ type: "raw", path: normalizedDraft });
  }
  return entries;
}

function commitWatchedPathsText(
  paths: string[],
  text: string,
): { nextPaths: string[]; rejectedText: string; message: string | null } {
  let nextPaths = paths;
  const rejected: string[] = [];
  let message: string | null = null;
  for (const entry of text.split(/[\n,]/)) {
    if (!entry.trim()) continue;
    const result = addWatchedPath(nextPaths, entry);
    if ("error" in result) {
      rejected.push(entry.trim());
      message ??= result.error;
    } else {
      nextPaths = result.paths;
    }
  }
  return { nextPaths, rejectedText: rejected.join(", "), message };
}

function pickerPlaceholder(atMax: boolean, pathCount: number): string {
  if (atMax) return `${MAX_WATCHED_PATHS} paths watched`;
  return pathCount > 0 ? "Add another file or folder…" : WATCHED_PATHS_PLACEHOLDER;
}

function handleComboboxKeyDown(
  event: KeyboardEvent<HTMLInputElement>,
  ctx: {
    optionsCount: number;
    activeOption: Option | undefined;
    showList: boolean;
    draft: string;
    paths: string[];
    setListOpen: (open: boolean) => void;
    setActive: (updater: (current: number) => number) => void;
    choose: (option: Option) => void;
    commitText: (text: string) => void;
    changeDraft: (next: string) => void;
    changePaths: (next: string[]) => void;
  },
) {
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp": {
      if (ctx.optionsCount === 0) return;
      event.preventDefault();
      ctx.setListOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const count = ctx.optionsCount;
      ctx.setActive((current) => (current < 0 ? (step === 1 ? 0 : count - 1) : (current + step + count) % count));
      return;
    }
    case "Enter":
      if (ctx.activeOption) {
        event.preventDefault();
        ctx.choose(ctx.activeOption);
      } else if (ctx.draft.trim()) {
        event.preventDefault();
        ctx.commitText(ctx.draft);
      }
      return;
    case "Tab":
      if (!event.shiftKey && ctx.activeOption?.type === "entry" && ctx.activeOption.suggestion.kind === "dir") {
        const next = `${ctx.activeOption.suggestion.path}/`;
        if (ctx.draft !== next) {
          event.preventDefault();
          ctx.changeDraft(next);
        }
      }
      return;
    case ",":
      event.preventDefault();
      ctx.commitText(ctx.draft);
      return;
    case "Backspace":
      if (ctx.draft === "" && ctx.paths.length > 0) ctx.changePaths(ctx.paths.slice(0, -1));
      return;
    case "Escape":
      if (ctx.showList) {
        event.preventDefault();
        event.stopPropagation();
        ctx.setListOpen(false);
      }
      return;
  }
}

function WatchedPathChips({
  paths,
  tree,
  onRemove,
}: {
  paths: string[];
  tree: TreeState;
  onRemove: (path: string) => void;
}) {
  if (paths.length === 0) return null;
  const index = tree.status === "ready" ? tree.index : null;
  const checkMissing = index !== null && tree.status === "ready" && !tree.tree.truncated;

  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Watched paths">
      {paths.map((path) => {
        const kind = index?.kinds.get(path);
        const missing = checkMissing && kind === undefined;
        return (
          <li key={path}>
            <span
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-md border bg-secondary py-0.5 pr-0.5 pl-1.5 font-mono text-xs",
                missing && "border-amber-500/40 bg-amber-500/10",
              )}
              title={missing ? `${path} is not on the default branch yet. It is still watched.` : path}
            >
              <KindIcon kind={kind} />
              <span className="truncate">{path}</span>
              <button
                type="button"
                onClick={() => onRemove(path)}
                className="rounded-sm p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                aria-label={`Stop watching ${path}`}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function suggestionRightHint(covered: string | null, suggestion: PathSuggestion, highlighted: boolean): string | null {
  if (covered) return covered === suggestion.path ? "Watched" : `In ${covered}/`;
  if (highlighted && suggestion.kind === "dir") return "Tab to open";
  return null;
}

function PathSuggestionsList({
  listId,
  options,
  active,
  query,
  onSetActive,
  onChoose,
}: {
  listId: string;
  options: Option[];
  active: number;
  query: string;
  onSetActive: (index: number) => void;
  onChoose: (option: Option) => void;
}) {
  return (
    <ul
      id={listId}
      role="listbox"
      aria-label="Matching files and folders"
      className="max-h-56 overflow-y-auto rounded-md border bg-popover p-1 text-xs shadow-sm"
    >
      {options.map((option, position) => {
        const highlighted = position === active;
        const common = {
          id: `${listId}-${position}`,
          onMouseDown: (event: MouseEvent) => event.preventDefault(),
          onMouseMove: () => onSetActive(position),
          onClick: () => onChoose(option),
        };
        if (option.type === "raw") {
          return (
            <li
              key="raw"
              role="option"
              aria-selected={highlighted}
              {...common}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5",
                highlighted && "bg-accent",
              )}
            >
              <PlusIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate">
                Watch <span className="font-mono">{option.path}</span>
              </span>
              <span className="ml-auto shrink-0 text-muted-foreground">not on the default branch</span>
            </li>
          );
        }
        const { suggestion, covered } = option;
        return (
          <li
            key={suggestion.path}
            role="option"
            aria-selected={highlighted}
            {...common}
            aria-disabled={covered ? true : undefined}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5",
              highlighted && "bg-accent",
              covered && "cursor-default opacity-60",
            )}
          >
            <KindIcon kind={suggestion.kind} />
            <span className="min-w-0 truncate font-mono">
              <Highlighted text={suggestion.path} start={suggestion.matchStart} length={query.length} />
              {suggestion.kind === "dir" ? "/" : null}
            </span>
            <span className="ml-auto shrink-0 text-muted-foreground">
              {suggestionRightHint(covered, suggestion, highlighted)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function FolderEntryRow({
  entry,
  selected,
  covered,
  atMax,
  onToggle,
  onOpenFolder,
}: {
  entry: RepoPathEntry;
  selected: boolean;
  covered: string | null;
  atMax: boolean;
  onToggle: (entry: RepoPathEntry) => void;
  onOpenFolder: (path: string) => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-accent">
      <Checkbox
        checked={selected || covered !== null}
        disabled={covered !== null || (!selected && atMax)}
        onCheckedChange={() => onToggle(entry)}
        aria-label={`Watch ${entry.path}`}
        title={covered ? `Included in ${covered}/` : undefined}
      />
      {entry.kind === "dir" ? (
        <button
          type="button"
          onClick={() => onOpenFolder(entry.path)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-label={`Open ${entry.path}`}
        >
          <KindIcon kind="dir" />
          <span className="truncate font-mono">{entry.name}</span>
          <ChevronRightIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            if (!covered && (selected || !atMax)) onToggle(entry);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          tabIndex={-1}
        >
          <KindIcon kind="file" />
          <span className="truncate font-mono">{entry.name}</span>
        </button>
      )}
    </li>
  );
}

function RepoFolderBrowser({
  browserId,
  repo,
  folder,
  index,
  paths,
  atMax,
  onSetFolder,
  onToggleEntry,
}: {
  browserId: string;
  repo: string | null;
  folder: string;
  index: RepoPathIndex;
  paths: string[];
  atMax: boolean;
  onSetFolder: (folder: string) => void;
  onToggleEntry: (entry: RepoPathEntry) => void;
}) {
  const children = index.children.get(folder) ?? [];
  const folderSegments = folder ? folder.split("/") : [];
  const pathSet = new Set(paths);

  return (
    <div id={browserId} className="rounded-md border text-xs">
      <nav aria-label="Folder" className="flex flex-wrap items-center gap-0.5 border-b px-2 py-1.5">
        <button
          type="button"
          onClick={() => onSetFolder("")}
          className={cn("rounded-sm px-1 hover:bg-accent", folder === "" && "font-medium")}
        >
          {rootLabel(repo)}
        </button>
        {folderSegments.map((segment, position) => {
          const path = folderSegments.slice(0, position + 1).join("/");
          return (
            <span key={path} className="flex items-center gap-0.5">
              <ChevronRightIcon className="size-3 text-muted-foreground" aria-hidden />
              <button
                type="button"
                onClick={() => onSetFolder(path)}
                className={cn("rounded-sm px-1 font-mono hover:bg-accent", path === folder && "font-medium")}
                aria-current={path === folder ? "location" : undefined}
              >
                {segment}
              </button>
            </span>
          );
        })}
      </nav>
      <ul className="max-h-60 overflow-y-auto p-1">
        {folder !== "" ? (
          <li>
            <button
              type="button"
              onClick={() => onSetFolder(folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "")}
              className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-muted-foreground hover:bg-accent"
            >
              <CornerLeftUpIcon className="size-3.5" aria-hidden />
              Up
            </button>
          </li>
        ) : null}
        {children.slice(0, BROWSER_ROW_LIMIT).map((entry) => {
          const selected = pathSet.has(entry.path);
          const covered = selected ? null : coveringPath(entry.path, paths);
          return (
            <FolderEntryRow
              key={entry.path}
              entry={entry}
              selected={selected}
              covered={covered}
              atMax={atMax}
              onToggle={onToggleEntry}
              onOpenFolder={onSetFolder}
            />
          );
        })}
        {children.length > BROWSER_ROW_LIMIT ? (
          <li className="px-1.5 py-1 text-muted-foreground">
            …and {children.length - BROWSER_ROW_LIMIT} more. Type a name above to find them.
          </li>
        ) : null}
        {children.length === 0 ? <li className="px-1.5 py-1 text-muted-foreground">Empty folder.</li> : null}
      </ul>
    </div>
  );
}

function TreeStatusMessage({ tree }: { tree: TreeState }) {
  if (tree.status === "idle") return "Enter the repository to browse its files.";
  if (tree.status === "loading") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <LoaderCircleIcon className="size-3 motion-safe:animate-spin" aria-hidden />
        Loading files…
      </span>
    );
  }
  if (tree.status === "error") {
    return `Couldn't list the files: ${tree.message.replace(/\.$/, "")}. You can still type paths.`;
  }
  return `${tree.tree.dirs.length.toLocaleString("en")} folders, ${tree.tree.files.length.toLocaleString("en")} files on ${tree.tree.defaultBranch}.${
    tree.tree.truncated ? " Large repository: not every file is listed, type any path." : ""
  }`;
}

function PickerStatusBar({
  statusId,
  tree,
  pathCount,
  atMax,
}: {
  statusId: string;
  tree: TreeState;
  pathCount: number;
  atMax: boolean;
}) {
  return (
    <p id={statusId} className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
      <span className="min-w-0">
        <TreeStatusMessage tree={tree} />
      </span>
      <span className={cn("shrink-0 tabular-nums", atMax && "text-foreground")}>
        {pathCount}/{MAX_WATCHED_PATHS}
      </span>
    </p>
  );
}

/**
 * Chips + autocomplete input + folder browser for the watched paths of "Files / folders" tracking.
 * Suggestions come from the repository's default branch (`listRepositoryPathsAction`); any valid
 * path can still be typed, so a missing tree, a GitHub error or a path that doesn't exist yet never
 * blocks the form. `draft` is the uncommitted text: forms should include it when submitting.
 */
export function WatchedPathsPicker({
  id,
  repo,
  paths,
  onPathsChange,
  draft,
  onDraftChange,
  error,
  autoFocus = false,
  debounceMs = 0,
  describedBy,
}: {
  /** Id of the text input, for the `<Label htmlFor>`. */
  id: string;
  /** `owner/repo` or a GitHub URL; `null` while unknown. */
  repo: string | null;
  paths: string[];
  onPathsChange: (paths: string[]) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
  /** An error from the parent (e.g. the Server Action); shown when the picker has none of its own. */
  error?: string | null;
  autoFocus?: boolean;
  /** Wait this long after `repo` changes before loading its tree (typing in the repository field). */
  debounceMs?: number;
  /** Ids of extra help text for the input. */
  describedBy?: string;
}) {
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = `${uid}-suggestions`;
  const browserId = `${uid}-browser`;
  const statusId = `${uid}-status`;
  const errorId = `${uid}-error`;
  const tree = useRepoTree(repo, debounceMs);
  const index = tree.status === "ready" ? tree.index : null;

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [browsing, setBrowsing] = useState(false);
  const [folder, setFolder] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const atMax = paths.length >= MAX_WATCHED_PATHS;
  const query = draft.trim().replace(/^(\.\/|\/)+/, "");
  const options = buildPathOptions(index, query, normalizeWatchedPath(draft), paths);
  const showList = listOpen && options.length > 0;
  const activeOption = showList && active >= 0 && active < options.length ? options[active] : undefined;

  function changePaths(next: string[]) {
    setLocalError(null);
    onPathsChange(next);
  }

  function changeDraft(next: string) {
    setLocalError(null);
    onDraftChange(next);
    setListOpen(true);
    // Highlight the best match while typing; nothing for an empty query (Enter submits the form).
    setActive(next.trim() ? 0 : -1);
  }

  /** Commits typed or pasted text (comma- or newline-separated). Invalid entries stay in the field. */
  function commitText(text: string): void {
    const { nextPaths, rejectedText, message } = commitWatchedPathsText(paths, text);
    if (nextPaths !== paths) onPathsChange(nextPaths);
    onDraftChange(rejectedText);
    setLocalError(message);
    setActive(-1);
  }

  function choose(option: Option) {
    if (option.type === "raw") return commitText(option.path);
    if (!option.covered) commitText(option.suggestion.path);
  }

  function toggleEntry(entry: RepoPathEntry) {
    if (paths.includes(entry.path)) return changePaths(paths.filter((path) => path !== entry.path));
    const result = addWatchedPath(paths, entry.path);
    if ("error" in result) setLocalError(result.error);
    else changePaths(result.paths);
  }

  const shownError = localError ?? error ?? null;

  return (
    <div className="grid gap-2">
      <WatchedPathChips paths={paths} tree={tree} onRemove={(path) => changePaths(paths.filter((p) => p !== path))} />

      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            id={id}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={activeOption ? `${listId}-${active}` : undefined}
            aria-invalid={shownError ? true : undefined}
            aria-describedby={[statusId, shownError ? errorId : null, describedBy].filter(Boolean).join(" ")}
            value={draft}
            onChange={(event) => changeDraft(event.target.value)}
            onKeyDown={(event) =>
              handleComboboxKeyDown(event, {
                optionsCount: options.length,
                activeOption,
                showList,
                draft,
                paths,
                setListOpen,
                setActive,
                choose,
                commitText,
                changeDraft,
                changePaths,
              })
            }
            onFocus={() => setListOpen(true)}
            onBlur={() => setListOpen(false)}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text");
              if (!/[\n,]/.test(text)) return;
              event.preventDefault();
              commitText(`${draft}${text}`);
            }}
            placeholder={pickerPlaceholder(atMax, paths.length)}
            autoComplete="off"
            spellCheck={false}
            className="h-8 pl-8 font-mono text-xs"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          aria-expanded={browsing}
          aria-controls={browserId}
          disabled={!index}
          onClick={() => setBrowsing((open) => !open)}
        >
          <FolderTreeIcon />
          Browse
        </Button>
      </div>

      {showList ? (
        <PathSuggestionsList
          listId={listId}
          options={options}
          active={active}
          query={query}
          onSetActive={setActive}
          onChoose={choose}
        />
      ) : null}

      {browsing && index ? (
        <RepoFolderBrowser
          browserId={browserId}
          repo={repo}
          folder={folder}
          index={index}
          paths={paths}
          atMax={atMax}
          onSetFolder={setFolder}
          onToggleEntry={toggleEntry}
        />
      ) : null}

      <PickerStatusBar statusId={statusId} tree={tree} pathCount={paths.length} atMax={atMax} />

      {shownError ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {shownError}
        </p>
      ) : null}
    </div>
  );
}
