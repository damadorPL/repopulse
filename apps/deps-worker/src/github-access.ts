import { createHash } from "node:crypto";
import { decryptToken, GitHubAppKeyUnreadableError, type DecryptedGitHubAppSettings } from "@repopulse/db";
import { GitHubAppAuthError, GitHubAppInstallationError, type GitHubAppAuth, type InstallationPermissions } from "@repopulse/github";
import { defaultGitHubApi, type GitHubApi, type Octokit } from "./github-api";
import { createLogger } from "./logger";

const log = createLogger("github-access");

/**
 * GitHub credentials of the deps-worker (Slice 08 §3.8.3, §3.6 step 1):
 * - the GitHub App (settings read from `InstanceSettings` on every call, so Admin changes apply without a restart);
 * - installation tokens narrowed to one repository, cached **in memory only** until 5 minutes before they expire,
 *   never stored or logged;
 * - the read-token fallback chain for scans: App installation → the owner's OAuth token → anonymous.
 */

/** Tokens are reused until this long before `expiresAt`. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export const PRIVATE_WITHOUT_APP_MESSAGE = "Install the GitHub App to check private repositories";

export const READ_PERMISSIONS: InstallationPermissions = { contents: "read", pull_requests: "read" };
export const WRITE_PERMISSIONS: InstallationPermissions = { contents: "write", pull_requests: "write" };

export interface AppContext {
  auth: GitHubAppAuth;
  slug: string;
}

export type ReadCandidate = { source: "app" | "oauth" | "anonymous"; token: string | undefined };

export type ReadAccess =
  | { kind: "ok"; candidates: ReadCandidate[]; installationId: number | null; app: AppContext | null }
  | { kind: "private-without-app"; message: string };

export interface AccessProject {
  owner: string;
  name: string;
  githubRepoId: number;
  isPrivate: boolean;
}

export interface AccessUser {
  id: string;
  githubAccessTokenEncrypted: string | null;
}

export interface GitHubAccessOptions {
  loadApp: () => Promise<DecryptedGitHubAppSettings | null>;
  github?: Pick<GitHubApi, "createAppOctokit" | "getRepoInstallation" | "createInstallationToken">;
  decrypt?: (encrypted: string) => string;
  now?: () => number;
}

export class GitHubAccess {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly appOctokits = new Map<string, Octokit>();
  private readonly github: NonNullable<GitHubAccessOptions["github"]>;
  private readonly decrypt: (encrypted: string) => string;
  private readonly now: () => number;

  constructor(private readonly options: GitHubAccessOptions) {
    this.github = options.github ?? defaultGitHubApi;
    this.decrypt = options.decrypt ?? decryptToken;
    this.now = options.now ?? Date.now;
  }

  /** The configured App, or `null` (not configured, or its key can't be decrypted). */
  async app(): Promise<AppContext | null> {
    try {
      const settings = await this.options.loadApp();
      if (!settings) return null;
      return { auth: { appId: settings.appId, privateKey: settings.privateKey }, slug: settings.slug };
    } catch (error) {
      if (error instanceof GitHubAppKeyUnreadableError) {
        log.warn(error.message);
        return null;
      }
      throw error;
    }
  }

  private appOctokit(app: AppContext): Octokit {
    // Keyed by a hash of id + key: a re-entered key gets a new client, and the key itself is never a map key.
    const key = createHash("sha256").update(`${app.auth.appId}\0${app.auth.privateKey}`).digest("hex");
    let octokit = this.appOctokits.get(key);
    if (!octokit) {
      octokit = this.github.createAppOctokit(app.auth);
      this.appOctokits.clear();
      this.appOctokits.set(key, octokit);
    }
    return octokit;
  }

  /**
   * The installation covering `owner/name`, or `null` (not installed, or the App credentials are rejected). With
   * `strict`, a credential failure (`GitHubAppAuthError`, which also covers a request that never reached GitHub)
   * is rethrown instead, so callers that act on "not installed" can tell the two apart.
   */
  async installation(app: AppContext, owner: string, name: string, options: { strict?: boolean } = {}): Promise<number | null> {
    try {
      const found = await this.github.getRepoInstallation(app.auth, owner, name, { octokit: this.appOctokit(app) });
      return found?.installationId ?? null;
    } catch (error) {
      if (error instanceof GitHubAppAuthError && !options.strict) {
        log.warn(`GitHub App credentials rejected: ${error.message}`);
        return null;
      }
      throw error;
    }
  }

  /** An installation token for one repository (`read` = contents + pull requests read; `write` = both write). */
  async installationToken(app: AppContext, installationId: number, githubRepoId: number, scope: "read" | "write"): Promise<string> {
    const key = `${app.auth.appId}:${installationId}:${githubRepoId}:${scope}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) return cached.token;
    const { token, expiresAt } = await this.github.createInstallationToken(
      app.auth,
      installationId,
      { repositoryIds: [githubRepoId], permissions: scope === "read" ? READ_PERMISSIONS : WRITE_PERMISSIONS },
      { octokit: this.appOctokit(app) },
    );
    this.tokens.set(key, { token, expiresAt: expiresAt.getTime() });
    return token;
  }

  /** Forgets cached tokens of an installation (after GitHub rejected one). */
  invalidate(installationId: number): void {
    for (const key of [...this.tokens.keys()]) if (key.split(":")[1] === String(installationId)) this.tokens.delete(key);
  }

  /** Number of cached tokens (tests). */
  get cachedTokenCount(): number {
    return this.tokens.size;
  }

  /**
   * Read credentials for a scan, best first. With the App installed on the repository: only the installation token.
   * Otherwise the owner's decryptable OAuth token, then anonymous; a private repository without the App gets
   * `private-without-app` (user-safe message, no retry).
   */
  async readAccess(project: AccessProject, user: AccessUser): Promise<ReadAccess> {
    const app = await this.app();
    if (app) {
      const installationId = await this.installation(app, project.owner, project.name);
      if (installationId !== null) {
        try {
          const token = await this.installationToken(app, installationId, project.githubRepoId, "read");
          return { kind: "ok", candidates: [{ source: "app", token }], installationId, app };
        } catch (error) {
          if (!(error instanceof GitHubAppInstallationError)) throw error;
          log.warn(`${project.owner}/${project.name}: ${error.message}`);
        }
      }
    }
    if (project.isPrivate) return { kind: "private-without-app", message: PRIVATE_WITHOUT_APP_MESSAGE };

    const candidates: ReadCandidate[] = [];
    if (user.githubAccessTokenEncrypted) {
      try {
        candidates.push({ source: "oauth", token: this.decrypt(user.githubAccessTokenEncrypted) });
      } catch {
        log.warn(`could not decrypt the GitHub token of user ${user.id}; reading anonymously`);
      }
    }
    candidates.push({ source: "anonymous", token: undefined });
    return { kind: "ok", candidates, installationId: null, app };
  }
}
