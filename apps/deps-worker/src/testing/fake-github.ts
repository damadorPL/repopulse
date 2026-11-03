/**
 * In-memory GitHub repository implementing the `GitHubApi` subset the processors use (tests only). Commits are
 * full file maps; blob SHAs are real Git blob ids, so `readBlobs` / `treeHasContent` behave like GitHub.
 */
import {
  gitBlobSha,
  GitHubRepositoryNotFoundError,
  RefUpdateConflictError,
  type CollaboratorPermission,
  type GitTreeSnapshot,
} from "@repopulse/github";

interface Commit {
  sha: string;
  files: Map<string, string>;
  parent: string | null;
  message: string;
}

export interface FakePr {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  comments: string[];
}

export function createFakeGitHub(init: {
  files: Record<string, string>;
  isPrivate?: boolean;
  repoId?: number;
  owner?: string;
  name?: string;
  defaultBranch?: string;
}) {
  const owner = init.owner ?? "acme";
  const name = init.name ?? "widget";
  const defaultBranch = init.defaultBranch ?? "main";
  let commitCounter = 0;
  const commits = new Map<string, Commit>();
  const blobs = new Map<string, string>();
  const branches = new Map<string, string>();
  const prs: FakePr[] = [];
  const state = {
    notFound: false,
    isPrivate: init.isPrivate ?? false,
    permissions: new Map<string, CollaboratorPermission>([["dev", "write"]]),
    logins: new Map<string, string>([["1001", "dev"]]),
    calls: [] as string[],
    tokensSeen: new Set<string | undefined>(),
  };

  const makeCommit = (files: Map<string, string>, parent: string | null, message: string): string => {
    const sha = `c${++commitCounter}`.padEnd(40, "0");
    for (const content of files.values()) blobs.set(gitBlobSha(content), content);
    commits.set(sha, { sha, files, parent, message });
    return sha;
  };
  branches.set(defaultBranch, makeCommit(new Map(Object.entries(init.files)), null, "initial"));

  const headFiles = (branch: string) => commits.get(branches.get(branch)!)!.files;

  const api = {
    createOctokit: ({ accessToken }: { accessToken?: string | null } = {}) => ({ token: accessToken ?? undefined }) as never,
    createAppOctokit: () => ({}) as never,
    getRepoInstallation: async () => null,
    createInstallationToken: async () => ({ token: "inst-token", expiresAt: new Date(Date.now() + 3600_000) }),

    fetchGitTree: async (params: { octokit?: unknown; owner: string; name: string }): Promise<GitTreeSnapshot> => {
      const token = (params.octokit as { token?: string } | undefined)?.token;
      state.tokensSeen.add(token);
      state.calls.push("fetchGitTree");
      if (state.notFound || (state.isPrivate && !token?.startsWith("inst-"))) throw new GitHubRepositoryNotFoundError(owner, name);
      const head = branches.get(defaultBranch)!;
      const entries = [...headFiles(defaultBranch)].map(([path, content]) => ({
        path,
        type: "blob" as const,
        sha: gitBlobSha(content),
        size: Buffer.byteLength(content),
      }));
      return {
        repository: { id: init.repoId ?? 42, owner, name, fullName: `${owner}/${name}`, defaultBranch, isPrivate: state.isPrivate, htmlUrl: `https://github.com/${owner}/${name}` },
        commitSha: head,
        entries: entries.sort((a, b) => (a.path < b.path ? -1 : 1)),
        truncated: false,
      };
    },
    readBlobs: async (_o: unknown, _owner: string, _repo: string, refs: ReadonlyArray<{ path: string; sha: string }>, options: { maxBytes: number }) => {
      state.calls.push(`readBlobs:${refs.map((r) => r.path).join(",")}`);
      return refs.map((ref) => {
        const content = blobs.get(ref.sha) ?? null;
        const size = content === null ? null : Buffer.byteLength(content);
        const oversize = size !== null && size > options.maxBytes;
        return { path: ref.path, sha: ref.sha, size, content: oversize ? null : content, oversize };
      });
    },
    getPullRequestState: async (_o: unknown, _owner: string, _repo: string, number: number) => {
      const pr = prs.find((p) => p.number === number);
      if (!pr) return null;
      return { state: pr.state, merged: pr.merged, headSha: branches.get(pr.head) ?? "", headRef: pr.head };
    },
    inspectBranch: async (_o: unknown, _owner: string, _repo: string, branch: string, expected: string | null | undefined) => {
      const head = branches.get(branch);
      if (!head) return { status: "missing" as const };
      return expected && head === expected ? { status: "owned" as const, headSha: head } : { status: "edited" as const, headSha: head };
    },
    treeHasContent: async (_o: unknown, _owner: string, _repo: string, commitSha: string, files: ReadonlyArray<{ path: string; content: string | Uint8Array }>) => {
      const commit = commits.get(commitSha);
      return !!commit && files.every((f) => commit.files.get(f.path) === f.content);
    },
    commitFiles: async (
      _o: unknown,
      params: { baseSha: string; branch: string; files: ReadonlyArray<{ path: string; content: string | Uint8Array }>; message: string; force: boolean; onPrepared?: (commitSha: string) => Promise<void> },
    ) => {
      state.calls.push(`commitFiles:${params.branch}:${params.files.map((f) => f.path).join(",")}`);
      if (!params.force && branches.has(params.branch)) throw new RefUpdateConflictError(`refs/heads/${params.branch}`, 422, "exists");
      const files = new Map(commits.get(params.baseSha)!.files);
      for (const file of params.files) files.set(file.path, String(file.content));
      const sha = makeCommit(files, params.baseSha, params.message);
      await params.onPrepared?.(sha);
      branches.set(params.branch, sha);
      return { commitSha: sha, treeSha: `tree-${sha}` };
    },
    upsertPullRequest: async (_o: unknown, params: { head: string; base: string; title: string; body: string; existingNumber?: number | null }) => {
      const existing = prs.find((p) => p.state === "open" && p.head === params.head);
      if (existing) {
        existing.title = params.title;
        existing.body = params.body;
        return { number: existing.number, htmlUrl: `https://github.com/${owner}/${name}/pull/${existing.number}`, state: "open" as const, created: false };
      }
      const pr: FakePr = { number: prs.length + 1, head: params.head, base: params.base, title: params.title, body: params.body, state: "open", merged: false, comments: [] };
      prs.push(pr);
      return { number: pr.number, htmlUrl: `https://github.com/${owner}/${name}/pull/${pr.number}`, state: "open" as const, created: true };
    },
    closePullRequest: async (_o: unknown, params: { number: number; comment?: string | null }) => {
      const pr = prs.find((p) => p.number === params.number)!;
      if (params.comment) pr.comments.push(params.comment);
      pr.state = "closed";
    },
    getCollaboratorPermission: async (_o: unknown, _owner: string, _repo: string, login: string) => state.permissions.get(login) ?? null,
    getUserLoginById: async (_o: unknown, id: string | number) => state.logins.get(String(id)) ?? null,
  };

  return {
    api: api as never,
    raw: api,
    state,
    prs,
    branches,
    /** Files on a branch (default branch when omitted). */
    files: (branch = defaultBranch) => Object.fromEntries(headFiles(branch)),
    commitMessage: (branch: string) => commits.get(branches.get(branch)!)!.message,
    /** A commit by someone else (human push). */
    push: (branch: string, files: Record<string, string>) => {
      const base = branches.get(branch) ?? branches.get(defaultBranch)!;
      const next = new Map(commits.get(base)!.files);
      for (const [path, content] of Object.entries(files)) next.set(path, content);
      branches.set(branch, makeCommit(next, base, "human"));
    },
    mergePr: (number: number) => {
      const pr = prs.find((p) => p.number === number)!;
      pr.state = "closed";
      pr.merged = true;
    },
    closePr: (number: number) => {
      prs.find((p) => p.number === number)!.state = "closed";
    },
  };
}

export type FakeGitHub = ReturnType<typeof createFakeGitHub>;
