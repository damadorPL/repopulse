import { createPrivateKey } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { GITHUB_USER_AGENT, isGitHubHttpError } from "./client.js";
import { rethrowRateLimit, toRateLimitError } from "./git-write.js";

/**
 * GitHub App helpers (Slice 08, Part B). The App gives RepoPulse scoped write access (contents + pull
 * requests), short-lived installation tokens and bot-authored commits.
 *
 * Secrets: no error thrown from this module ever contains the private key, a JWT or an installation
 * token. Errors from the JWT signer are replaced by {@link GitHubAppAuthError} without a `cause`.
 */

export interface GitHubAppAuth {
  appId: number;
  /** PEM (PKCS#1 as GitHub generates it, or PKCS#8). Escaped `\n` sequences (env vars) are accepted. */
  privateKey: string;
}

export interface GitHubAppRequestOptions {
  /** Custom fetch implementation (tests). */
  fetch?: typeof globalThis.fetch;
  /** API base URL (default `https://api.github.com`). */
  baseUrl?: string;
}

/** The App id, key or installation was rejected (401 / bad PEM). Safe to show to the super admin. */
export class GitHubAppAuthError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubAppAuthError";
    this.status = status;
  }
}

/** The installation is gone, suspended, or doesn't cover the repository / permissions requested. */
export class GitHubAppInstallationError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubAppInstallationError";
    this.status = status;
  }
}

const noop = () => {};

function octokitOptions(options: GitHubAppRequestOptions) {
  return {
    userAgent: GITHUB_USER_AGENT,
    log: { debug: noop, info: noop, warn: console.warn.bind(console), error: noop },
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
  };
}

/** Restores escaped line breaks and checks the PEM parses, without ever echoing it. */
function normalizePrivateKey(privateKey: string): string {
  const pem = privateKey.replace(/\\n/g, "\n").trim();
  try {
    createPrivateKey(pem);
  } catch {
    throw new GitHubAppAuthError("The GitHub App private key is not a valid PEM private key.");
  }
  return `${pem}\n`;
}

function assertAppId(appId: number): void {
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new GitHubAppAuthError("The GitHub App id must be a positive integer.");
}

/**
 * An Octokit that authenticates as the App itself (a JWT signed with the private key, renewed by
 * `@octokit/auth-app`). Only App-level routes work with it (`/app`, `/app/installations/…`,
 * `/repos/{o}/{r}/installation`, …); repository content needs an installation token
 * ({@link createInstallationToken}).
 */
export function createAppOctokit(auth: GitHubAppAuth, options: GitHubAppRequestOptions = {}): Octokit {
  assertAppId(auth.appId);
  const privateKey = normalizePrivateKey(auth.privateKey);
  return new Octokit({
    ...octokitOptions(options),
    authStrategy: createAppAuth,
    auth: { appId: auth.appId, privateKey },
  });
}

/**
 * Maps errors of App-authenticated calls: rate limits → `GitHubRateLimitError`, 401 →
 * {@link GitHubAppAuthError}, non-HTTP errors (the JWT signer) → {@link GitHubAppAuthError} without
 * the original error (it may describe the key). Other HTTP errors are re-thrown as they are
 * (Octokit redacts the `authorization` header).
 */
export function rethrowAppError(error: unknown, notFound?: () => never): never {
  if (error instanceof GitHubAppAuthError || error instanceof GitHubAppInstallationError) throw error;
  const rateLimited = toRateLimitError(error);
  if (rateLimited) throw rateLimited;
  if (isGitHubHttpError(error)) {
    if (error.status === 401) {
      throw new GitHubAppAuthError("GitHub rejected the App credentials. Check the App id and the private key.", 401);
    }
    if (error.status === 404 && notFound) notFound();
    throw error;
  }
  throw new GitHubAppAuthError("Could not sign a GitHub App token with this private key.");
}


export interface GitHubAppInfo {
  id: number;
  slug: string;
  name: string;
  clientId: string | null;
  owner: string | null;
  htmlUrl: string;
}

interface AppData {
  id: number;
  slug?: string;
  name: string;
  client_id?: string | null;
  owner?: { login?: string | null } | null;
  html_url: string;
}

function mapApp(data: AppData): GitHubAppInfo {
  return {
    id: data.id,
    slug: data.slug ?? "",
    name: data.name,
    clientId: data.client_id ?? null,
    owner: data.owner?.login ?? null,
    htmlUrl: data.html_url,
  };
}

/**
 * `GET /app` with the App JWT: validates the id + key pair (manual setup form) and returns the
 * App's public data. Throws {@link GitHubAppAuthError} on a bad key or id (GitHub answers 401 for a
 * JWT whose `iss` doesn't match the key, and 404 when the App doesn't exist).
 */
export async function getAuthenticatedApp(auth: GitHubAppAuth, options: GitHubAppRequestOptions = {}): Promise<GitHubAppInfo> {
  const octokit = createAppOctokit(auth, options);
  try {
    const response = await octokit.request("GET /app");
    if (!response.data) throw new GitHubAppAuthError("GitHub returned no App for these credentials.");
    return mapApp(response.data as AppData);
  } catch (error) {
    rethrowAppError(error, () => {
      throw new GitHubAppAuthError("No GitHub App matches this App id and private key.", 404);
    });
  }
}

export interface ConvertedAppManifest {
  id: number;
  slug: string;
  name: string;
  clientId: string;
  clientSecret: string;
  pem: string;
  webhookSecret: string | null;
  owner: string | null;
  htmlUrl: string;
}

/**
 * Completes the manifest flow: `POST /app-manifests/{code}/conversions` (unauthenticated; the code is
 * single-use and expires after one hour). The result contains the App's secrets: encrypt before storing.
 */
export async function convertAppManifest(code: string, options: GitHubAppRequestOptions = {}): Promise<ConvertedAppManifest> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) throw new GitHubAppAuthError("The GitHub App manifest code is malformed.");
  const octokit = new Octokit(octokitOptions(options));
  try {
    const response = await octokit.request("POST /app-manifests/{code}/conversions", { code });
    const data = response.data as AppData & {
      client_id: string;
      client_secret: string;
      pem: string;
      webhook_secret?: string | null;
    };
    return {
      ...mapApp(data),
      clientId: data.client_id,
      clientSecret: data.client_secret,
      pem: data.pem,
      webhookSecret: data.webhook_secret ?? null,
    };
  } catch (error) {
    if (isGitHubHttpError(error) && (error.status === 404 || error.status === 422)) {
      throw new GitHubAppAuthError("GitHub did not accept the App manifest code. It is single-use and expires after an hour; start again.", error.status);
    }
    rethrowRateLimit(error);
  }
}

/**
 * `GET /repos/{owner}/{repo}/installation` (App JWT). `null` when the App is not installed on the
 * repository (404).
 */
export async function getRepoInstallation(
  auth: GitHubAppAuth,
  owner: string,
  repo: string,
  options: GitHubAppRequestOptions & { octokit?: Octokit } = {},
): Promise<{ installationId: number; accountLogin: string } | null> {
  const octokit = options.octokit ?? createAppOctokit(auth, options);
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
    const account = response.data.account as { login?: string; slug?: string } | null;
    return { installationId: response.data.id, accountLogin: account?.login ?? account?.slug ?? owner };
  } catch (error) {
    if (isGitHubHttpError(error) && error.status === 404) return null;
    rethrowAppError(error);
  }
}

export type InstallationPermissions = Partial<Record<"contents" | "pull_requests" | "metadata", "read" | "write">>;

/**
 * `POST /app/installations/{id}/access_tokens`, narrowed to `repositoryIds` and `permissions`
 * (GitHub rejects permissions the installation wasn't granted with 422). Tokens live one hour;
 * never store or log them.
 */
export async function createInstallationToken(
  auth: GitHubAppAuth,
  installationId: number,
  opts: { repositoryIds: number[]; permissions: InstallationPermissions },
  options: GitHubAppRequestOptions & { octokit?: Octokit } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const octokit = options.octokit ?? createAppOctokit(auth, options);
  try {
    const response = await octokit.request("POST /app/installations/{installation_id}/access_tokens", {
      installation_id: installationId,
      repository_ids: opts.repositoryIds,
      permissions: opts.permissions,
    });
    return { token: response.data.token, expiresAt: new Date(response.data.expires_at) };
  } catch (error) {
    if (isGitHubHttpError(error)) {
      if (error.status === 404) {
        throw new GitHubAppInstallationError("The GitHub App installation no longer exists.", 404);
      }
      if (error.status === 422) {
        throw new GitHubAppInstallationError(
          "The GitHub App installation does not cover this repository or lacks the requested permissions.",
          422,
        );
      }
      if (error.status === 403 && !toRateLimitError(error)) {
        throw new GitHubAppInstallationError("The GitHub App installation is suspended or not allowed to create this token.", 403);
      }
    }
    rethrowAppError(error);
  }
}

export type CollaboratorPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

const PERMISSIONS: readonly CollaboratorPermission[] = ["admin", "maintain", "write", "triage", "read", "none"];

function asPermission(value: unknown): CollaboratorPermission | null {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value) ? (value as CollaboratorPermission) : null;
}

/**
 * `GET /repos/{owner}/{repo}/collaborators/{username}/permission`. Uses `role_name` (which tells
 * `maintain` and `triage` apart from `write` / `read`); a custom organization role falls back to the
 * base `permission`. `null` when GitHub answers 404 (unknown user or no access to the repository).
 */
export async function getCollaboratorPermission(
  octokit: Octokit,
  owner: string,
  repo: string,
  username: string,
): Promise<CollaboratorPermission | null> {
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", {
      owner,
      repo,
      username,
    });
    const data = response.data as { permission?: string; role_name?: string };
    return asPermission(data.role_name) ?? asPermission(data.permission) ?? "none";
  } catch (error) {
    if (isGitHubHttpError(error) && error.status === 404) return null;
    rethrowRateLimit(error);
  }
}

const WRITE_PERMISSIONS: ReadonlySet<CollaboratorPermission> = new Set(["write", "maintain", "admin"]);
const READ_PERMISSIONS: ReadonlySet<CollaboratorPermission> = new Set(["read", "triage", "write", "maintain", "admin"]);

/** `write` = write | maintain | admin; `read` = read | triage | write | maintain | admin. */
export function permissionAtLeast(permission: CollaboratorPermission | null, min: "read" | "write"): boolean {
  if (!permission) return false;
  return (min === "write" ? WRITE_PERMISSIONS : READ_PERMISSIONS).has(permission);
}

/**
 * Where users install the App.
 *
 * GitHub can pre-select a repository only together with the account it belongs to:
 * `/apps/<slug>/installations/new/permissions?suggested_target_id=<accountId>&repository_ids[]=<repoId>`
 * (the account is the repository owner's numeric user / organization id). Without `targetId`,
 * `repository_ids` would be ignored, so the plain `/installations/new` (account picker) is returned.
 */
export function installUrl(slug: string, githubRepoId?: number, targetId?: number): string {
  const base = `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
  if (targetId === undefined || !Number.isSafeInteger(targetId) || targetId <= 0) return base;
  const params = new URLSearchParams({ suggested_target_id: String(targetId) });
  if (githubRepoId !== undefined && Number.isSafeInteger(githubRepoId) && githubRepoId > 0) {
    params.append("repository_ids[]", String(githubRepoId));
  }
  return `${base}/permissions?${params.toString()}`;
}

/** GitHub's App name limit. */
export const GITHUB_APP_NAME_MAX_LENGTH = 34;

function truncateName(name: string): string {
  const chars = Array.from(name.trim());
  return chars.length <= GITHUB_APP_NAME_MAX_LENGTH ? chars.join("") : chars.slice(0, GITHUB_APP_NAME_MAX_LENGTH).join("").trimEnd();
}

/** "RepoPulse (<host>)", with the host cut so the whole name fits in 34 characters. */
export function defaultAppName(appBaseUrl: string): string {
  const host = new URL(appBaseUrl).host;
  const room = GITHUB_APP_NAME_MAX_LENGTH - "RepoPulse ()".length;
  return `RepoPulse (${host.length <= room ? host : host.slice(0, room)})`;
}

/** The manifest of §3.8.1 (`POST https://github.com/settings/apps/new`, form field `manifest`). */
export function buildAppManifest(opts: { appBaseUrl: string; name?: string }): Record<string, unknown> {
  const base = opts.appBaseUrl.trim().replace(/\/+$/, "");
  const parsed = new URL(base);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("APP_BASE_URL must be an http(s) URL.");
  const name = opts.name?.trim() ? truncateName(opts.name) : defaultAppName(base);
  return {
    name,
    url: base,
    redirect_url: `${base}/api/github-app/manifest/callback`,
    setup_url: `${base}/dependencies?installed=1`,
    setup_on_update: true,
    public: true,
    hook_attributes: { url: `${base}/api/github-app/webhook`, active: false },
    default_permissions: { metadata: "read", contents: "write", pull_requests: "write" },
    default_events: [],
  };
}

/** GitHub logins: alphanumerics and single hyphens, no leading / trailing hyphen, at most 39 characters. */
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function isValidGitHubLogin(login: string): boolean {
  return GITHUB_LOGIN_PATTERN.test(login);
}

/**
 * Target of the manifest form: the personal account (`/settings/apps/new`) or an organization
 * (`/organizations/<org>/settings/apps/new`). Throws on an invalid organization login.
 */
export function appManifestFormUrl(state: string, organization?: string): string {
  const query = `state=${encodeURIComponent(state)}`;
  const org = organization?.trim();
  if (!org) return `https://github.com/settings/apps/new?${query}`;
  if (!isValidGitHubLogin(org)) throw new Error("The organization name is not a valid GitHub login.");
  return `https://github.com/organizations/${org}/settings/apps/new?${query}`;
}

/** `GET /user/{account_id}`: the current login of a GitHub user id (logins can change). `null` on 404. */
export async function getUserLoginById(octokit: Octokit, githubId: string | number): Promise<string | null> {
  const id = String(githubId);
  if (!/^\d{1,20}$/.test(id)) return null;
  try {
    const response = await octokit.request("GET /user/{account_id}", { account_id: Number(id) });
    return (response.data as { login?: string }).login ?? null;
  } catch (error) {
    if (isGitHubHttpError(error) && error.status === 404) return null;
    rethrowRateLimit(error);
  }
}
