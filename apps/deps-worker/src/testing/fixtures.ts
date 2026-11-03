import { vi } from "vitest";
import type { Job } from "bullmq";
import type { DependencyEcosystem, RegistryLookup, RegistryVersion } from "@repopulse/deps";
import { GitHubAccess } from "../github-access";
import type { FakeGitHub } from "./fake-github";

export const NOW = new Date("2026-11-03T12:00:00Z");
const DAY = 24 * 3600_000;

export function version(v: string, ageDays = 30, extra: Partial<RegistryVersion> = {}): RegistryVersion {
  return { version: v, publishedAt: new Date(NOW.getTime() - ageDays * DAY), deprecated: false, yanked: false, requiresPython: null, sha256: [], ...extra };
}

/** `{ "NPM:react": [versions] }` → a registry lookup function; unknown names are "not found". */
export function fakeRegistry(packages: Record<string, RegistryVersion[] | Error>) {
  return vi.fn(async (ecosystem: DependencyEcosystem, name: string): Promise<RegistryLookup> => {
    const entry = packages[`${ecosystem}:${name}`];
    if (entry instanceof Error) throw entry;
    if (!entry) return { found: false, reason: "Not on the public registry" };
    return { found: true, package: { ecosystem, name, versions: entry, latestTag: null, sourceRepoUrl: "https://github.com/psf/requests" } };
  });
}

export const hex = (c: string) => c.repeat(64);

export const HASHED_REQUIREMENTS = `requests==2.31.0 \\\n    --hash=sha256:${hex("a")} \\\n    --hash=sha256:${hex("b")}\nflask==3.0.0\n`;

export function pypiRegistry() {
  return fakeRegistry({
    "PYPI:requests": [version("2.31.0", 300), version("2.32.3", 40, { sha256: [hex("d"), hex("c")] })],
    "PYPI:flask": [version("3.0.0", 300)],
  });
}

/** A `GitHubAccess` wired to the fake repository: `installed` = the App is installed on it. */
export function fakeAccess(github: FakeGitHub, options: { app?: boolean; installed?: boolean; installationError?: Error } = {}) {
  const app = options.app ?? true;
  return new GitHubAccess({
    loadApp: async () =>
      app ? { appId: 1, slug: "repopulse-test", clientId: null, owner: null, privateKey: "PEM", webhookSecret: null } : null,
    github: {
      createAppOctokit: () => ({}) as never,
      getRepoInstallation: async () => {
        if (options.installationError) throw options.installationError;
        return options.installed ? { installationId: 7, accountLogin: "acme" } : null;
      },
      createInstallationToken: github.raw.createInstallationToken,
    },
    decrypt: (value) => `oauth-${value}`,
  });
}

export function fakeQueues() {
  return {
    scanQueue: { rateLimit: vi.fn(async () => undefined), addBulk: vi.fn(async () => []) },
    updateQueue: { rateLimit: vi.fn(async () => undefined), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => undefined) },
    notifyQueue: { addBulk: vi.fn(async (_jobs: Array<{ data: unknown; opts: { jobId: string } }>) => []) },
    redis: { publish: vi.fn(async () => 1) },
  };
}

export function job<T>(data: T, attemptsMade = 0, attempts = 3): Job<T> {
  return { data, attemptsMade, opts: { attempts }, log: vi.fn(async () => 0) } as unknown as Job<T>;
}

/** Events published to `user:u1:events`, parsed. */
export function published(redis: { publish: ReturnType<typeof vi.fn> }): Array<Record<string, unknown>> {
  return redis.publish.mock.calls.map((call) => JSON.parse(call[1] as string) as Record<string, unknown>);
}
