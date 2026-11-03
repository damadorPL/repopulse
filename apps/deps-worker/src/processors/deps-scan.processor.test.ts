import { describe, expect, it, vi } from "vitest";
import { RegistryUnavailableError } from "@repopulse/deps";
import { GitHubRateLimitError } from "@repopulse/github";
import type { DepsScanJobData } from "@repopulse/queue";
import { createFakeGitHub, type FakeGitHub } from "../testing/fake-github";
import { createFakePrisma, seed, type FakePrisma } from "../testing/fake-prisma";
import { flushNotificationOutbox } from "../notification-outbox";
import { fakeAccess, fakeQueues, fakeRegistry, HASHED_REQUIREMENTS, job, NOW, published, pypiRegistry, version } from "../testing/fixtures";
import { MAX_ERROR_COUNT, NO_ACCESS_MESSAGE, PAUSED_RESCAN_MS, processDepsScan } from "./deps-scan.processor";

function setup(options: {
  files?: Record<string, string>;
  project?: Record<string, unknown>;
  isPrivate?: boolean;
  app?: boolean;
  installed?: boolean;
  registry?: ReturnType<typeof fakeRegistry>;
  depsEnabled?: boolean;
} = {}) {
  const prisma = createFakePrisma();
  const project = seed(prisma, { project: options.project ?? {}, ...(options.depsEnabled === false ? { depsEnabled: false } : {}) });
  prisma.notificationRule.rows.push(
    { id: "r-deps", userId: "u1", tagId: null, channel: "DISCORD_WEBHOOK", destinationUrl: "https://discord.com/api/webhooks/1/x", enabled: true, events: ["DEPENDENCY_UPDATES", "DEPENDENCY_PULL_REQUESTS"] },
    { id: "r-releases", userId: "u1", tagId: null, channel: "DISCORD_WEBHOOK", destinationUrl: "https://discord.com/api/webhooks/2/x", enabled: true, events: ["RELEASES"] },
    { id: "r-inapp", userId: "u1", tagId: null, channel: "IN_APP", destinationUrl: null, enabled: true, events: ["DEPENDENCY_UPDATES"] },
  );
  const github = createFakeGitHub({ files: options.files ?? { "requirements.txt": HASHED_REQUIREMENTS }, isPrivate: options.isPrivate ?? false });
  const queues = fakeQueues();
  let clock = NOW;
  const deps = {
    prisma: prisma as never,
    ...queues,
    access: fakeAccess(github, { app: options.app ?? false, installed: options.installed ?? false }),
    github: github.api,
    registry: options.registry ?? pypiRegistry(),
    lockfileRegeneration: false,
    now: () => clock,
  };
  return { prisma, project, github, queues, deps, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

const scanJob = (data: Partial<DepsScanJobData> = {}, attemptsMade = 0) => job<DepsScanJobData>({ projectId: "p1", trigger: "schedule", ...data }, attemptsMade);

function digestJobs(queues: ReturnType<typeof fakeQueues>) {
  return queues.notifyQueue.addBulk.mock.calls.flatMap(([jobs]) => jobs).filter((j) => (j.data as { kind: string }).kind === "digest");
}

function rows(prisma: FakePrisma) {
  return Object.fromEntries(prisma.dependencyUpdate.rows.map((row) => [row.name as string, row]));
}

describe("processDepsScan", () => {
  it("keeps digest intents durable when Redis fails after notifiedAt is committed", async () => {
    const { deps, prisma, queues } = setup({ project: { lastScannedAt: new Date("2026-10-01T00:00:00Z") } });
    queues.notifyQueue.addBulk.mockRejectedValueOnce(new Error("Redis unavailable"));
    expect(await processDepsScan(scanJob(), deps)).toMatchObject({ status: "SCANNED", digests: 1 });
    expect(rows(prisma).requests!.notifiedAt).toEqual(NOW);
    expect(prisma.dependencyNotificationOutbox.rows).toHaveLength(1);
    // A recovery dispatcher does not need a fresh scan or unannounced update rows.
    await flushNotificationOutbox(deps.prisma, deps.notifyQueue);
    expect(prisma.dependencyNotificationOutbox.rows).toHaveLength(0);
    const calls = queues.notifyQueue.addBulk.mock.calls;
    expect(calls[0]![0]).toEqual(calls[1]![0]);
    await processDepsScan(scanJob(), deps);
    expect(queues.notifyQueue.addBulk).toHaveBeenCalledTimes(2);
  });

  it("does nothing while the module is disabled", async () => {
    const { deps, prisma } = setup({ depsEnabled: false });
    expect(await processDepsScan(scanJob(), deps)).toEqual({ status: "SKIPPED", reason: "DISABLED" });
    expect(prisma.dependencyProject.rows[0]!.scanStatus).toBe("IDLE");
  });

  it("persists manifests and rows, then sends a digest once per new target", async () => {
    const { deps, prisma, queues, github, advance } = setup({ project: { lastScannedAt: new Date("2026-10-01T00:00:00Z") } });

    const first = await processDepsScan(scanJob(), deps);
    expect(first).toMatchObject({ status: "SCANNED", manifests: 1, dependencies: 2, outdated: 1, majors: 0, digests: 1 });
    expect(prisma.dependencyManifest.rows).toEqual([
      expect.objectContaining({ path: "requirements.txt", packageManager: "PIP", ecosystem: "PYPI", dependencyCount: 2 }),
    ]);
    // flask is up to date: no row.
    expect(Object.keys(rows(prisma))).toEqual(["requests"]);
    expect(rows(prisma).requests).toMatchObject({
      status: "OUTDATED",
      currentVersion: "2.31.0",
      targetVersion: "2.32.3",
      level: "MINOR",
      firstSeenAt: NOW,
      notifiedAt: NOW,
    });
    expect(prisma.dependencyProject.rows[0]).toMatchObject({ scanStatus: "IDLE", errorCount: 0, lastScannedAt: NOW, scanError: null });
    // Only the rule with DEPENDENCY_UPDATES and a deliverable channel.
    const [digest] = digestJobs(queues);
    expect(digest!.data).toMatchObject({ ruleId: "r-deps", projectId: "p1", kind: "digest", updateIds: [rows(prisma).requests!.id] });
    expect(digest!.opts.jobId).toMatch(/^deps-notify-r-deps-[0-9a-f]+$/);
    expect(published(queues.redis)).toContainEqual({ type: "DEPS_SCAN_COMPLETED", projectId: "p1", fullName: "acme/widget", outdated: 1, majors: 0 });

    // Same target on the next scan: firstSeenAt / notifiedAt kept, no second digest, unchanged blobs re-read only if not cached.
    advance(3600_000);
    await processDepsScan(scanJob(), deps);
    expect(rows(prisma).requests).toMatchObject({ firstSeenAt: NOW, notifiedAt: NOW });
    expect(digestJobs(queues)).toHaveLength(1);

    // A newer version: both reset, a new digest.
    deps.registry = fakeRegistry({
      "PYPI:requests": [version("2.31.0", 300), version("2.32.3", 40), version("2.33.0", 10)],
      "PYPI:flask": [version("3.0.0", 300)],
    });
    advance(3600_000);
    await processDepsScan(scanJob(), deps);
    const later = new Date(NOW.getTime() + 2 * 3600_000);
    expect(rows(prisma).requests).toMatchObject({ targetVersion: "2.33.0", firstSeenAt: later, notifiedAt: later });
    expect(digestJobs(queues)).toHaveLength(2);
    // Same row id, new target: a distinct jobId, so BullMQ's dedup (jobs kept 7 days) does not drop it.
    const [firstDigest, secondDigest] = digestJobs(queues);
    expect(secondDigest!.opts.jobId).not.toBe(firstDigest!.opts.jobId);
    expect(github.state.tokensSeen).toEqual(new Set([undefined]));
  });

  it("records a silent baseline on the first scan unless notifyOnFirstScan", async () => {
    const quiet = setup();
    await processDepsScan(scanJob({ trigger: "add" }), quiet.deps);
    expect(digestJobs(quiet.queues)).toHaveLength(0);
    expect(rows(quiet.prisma).requests!.notifiedAt).toEqual(NOW);
    await processDepsScan(scanJob(), quiet.deps);
    expect(digestJobs(quiet.queues)).toHaveLength(0);

    const loud = setup({ project: { notifyOnFirstScan: true } });
    await processDepsScan(scanJob({ trigger: "add" }), loud.deps);
    expect(digestJobs(loud.queues)).toHaveLength(1);
  });

  it("leaves updates below the notification level out of the digest", async () => {
    const { deps, prisma, queues } = setup({
      project: { lastScannedAt: new Date("2026-10-01T00:00:00Z") },
      registry: fakeRegistry({ "PYPI:requests": [version("2.31.0", 300), version("2.31.1", 40)], "PYPI:flask": [version("3.0.0", 300)] }),
    });
    await processDepsScan(scanJob(), deps);
    expect(rows(prisma).requests).toMatchObject({ status: "OUTDATED", level: "PATCH", notifiedAt: null });
    expect(digestJobs(queues)).toHaveLength(0);
  });

  it("refuses a private repository without the GitHub App (user-safe error, no retry)", async () => {
    const { deps, prisma, queues } = setup({ project: { isPrivate: true }, isPrivate: true });
    expect(await processDepsScan(scanJob({ trigger: "manual", requestedByUserId: "u1" }), deps)).toEqual({ status: "PRIVATE_WITHOUT_APP" });
    expect(prisma.dependencyProject.rows[0]).toMatchObject({
      scanStatus: "ERROR",
      scanError: "Install the GitHub App to check private repositories",
      errorCount: 0,
    });
    expect(published(queues.redis)).toContainEqual(expect.objectContaining({ type: "DEPS_SCAN_FAILED", message: "Install the GitHub App to check private repositories" }));
  });

  it("reads a private repository with the installation token when the App is installed", async () => {
    const { deps, github } = setup({ project: { isPrivate: true }, isPrivate: true, app: true, installed: true });
    expect(await processDepsScan(scanJob(), deps)).toMatchObject({ status: "SCANNED", outdated: 1 });
    expect(github.state.tokensSeen).toEqual(new Set(["inst-token"]));
  });

  it("re-checks the owner's read permission on a private repository and writes nothing without it", async () => {
    const { deps, prisma, github } = setup({ project: { isPrivate: true }, isPrivate: true, app: true, installed: true });
    github.state.permissions.set("dev", "none");
    expect(await processDepsScan(scanJob(), deps)).toEqual({ status: "NO_ACCESS", switchedToNotify: false });
    expect(prisma.dependencyProject.rows[0]).toMatchObject({
      scanStatus: "ERROR",
      scanError: NO_ACCESS_MESSAGE,
      errorCount: 0,
      lastScannedAt: null,
    });
    expect(prisma.dependencyManifest.rows).toEqual([]);
    expect(prisma.dependencyUpdate.rows).toEqual([]);
  });

  it("switches a PR-mode project to notify-only when the owner lost read access", async () => {
    const { deps, prisma, github, queues } = setup({ project: { isPrivate: true, updateMode: "AUTO_PR" }, isPrivate: true, app: true, installed: true });
    prisma.dependencyPrOwner.rows.push({ githubRepoId: 42, projectId: "p1" });
    github.state.permissions.delete("dev");
    github.state.logins.delete("1001");
    expect(await processDepsScan(scanJob(), deps)).toEqual({ status: "NO_ACCESS", switchedToNotify: true });
    expect(prisma.dependencyProject.rows[0]!.updateMode).toBe("NOTIFY");
    expect(prisma.dependencyPrOwner.rows).toEqual([]);
    const prJobs = queues.notifyQueue.addBulk.mock.calls.flatMap(([jobs]) => jobs).map((j) => j.data as Record<string, unknown>);
    expect(prJobs).toEqual([expect.objectContaining({ ruleId: "r-deps", kind: "pull_request", event: "access_lost" })]);
  });

  it("re-resolves a renamed login before refusing a private repository", async () => {
    const { deps, prisma } = setup({ project: { isPrivate: true }, isPrivate: true, app: true, installed: true });
    prisma.user.rows[0]!.githubLogin = "old-login";
    expect(await processDepsScan(scanJob(), deps)).toMatchObject({ status: "SCANNED" });
    expect(prisma.user.rows[0]!.githubLogin).toBe("dev");
  });

  it("counts 404s and pauses the project after five", async () => {
    const { deps, prisma, github } = setup({ project: { errorCount: MAX_ERROR_COUNT - 1 } });
    github.state.notFound = true;
    expect(await processDepsScan(scanJob(), deps)).toEqual({ status: "NOT_FOUND", errorCount: MAX_ERROR_COUNT });
    const row = prisma.dependencyProject.rows[0]!;
    expect(row.scanStatus).toBe("ERROR");
    expect(row.scanError).toContain("was not found on GitHub");
    expect(row.nextScanAt).toEqual(new Date(NOW.getTime() + PAUSED_RESCAN_MS));
  });

  it("keeps the previous results and retries when a registry is unavailable", async () => {
    const { deps, prisma } = setup({ project: { lastScannedAt: new Date("2026-10-01T00:00:00Z") } });
    await processDepsScan(scanJob(), deps);
    const before = structuredClone(prisma.dependencyUpdate.rows);
    deps.registry = fakeRegistry({ "PYPI:requests": new RegistryUnavailableError("pypi", 503, "PyPI responded 503"), "PYPI:flask": [] });
    await expect(processDepsScan(scanJob({}, 0), deps)).rejects.toBeInstanceOf(RegistryUnavailableError);
    expect(prisma.dependencyUpdate.rows).toEqual(before);
    expect(prisma.dependencyProject.rows[0]).toMatchObject({ scanStatus: "QUEUED", errorCount: 0 });

    await expect(processDepsScan(scanJob({}, 2), deps)).rejects.toBeInstanceOf(RegistryUnavailableError);
    expect(prisma.dependencyProject.rows[0]).toMatchObject({ scanStatus: "ERROR", errorCount: 1, scanError: "PyPI is not responding. The check will be retried." });
  });

  it("pauses the queue on a GitHub rate limit without consuming an attempt", async () => {
    const { deps, github, queues } = setup();
    github.raw.fetchGitTree = vi.fn(async () => {
      throw new GitHubRateLimitError(new Date(NOW.getTime() + 600_000));
    }) as never;
    deps.github = github.raw as never;
    await expect(processDepsScan(scanJob(), deps)).rejects.toMatchObject({ name: "RateLimitError" });
    expect(queues.scanQueue.rateLimit).toHaveBeenCalledWith(601_000);
  });

  describe("pull request refresh", () => {
    async function withOpenPr(github: FakeGitHub, prisma: FakePrisma) {
      github.push("repopulse/deps/all", { "requirements.txt": "requests==2.32.3\n" });
      const pr = await github.raw.upsertPullRequest({}, { head: "repopulse/deps/all", base: "main", title: "t", body: "b" });
      prisma.dependencyPullRequest.rows.push({
        id: "pr1",
        projectId: "p1",
        groupKey: "all",
        branch: "repopulse/deps/all",
        number: pr.number,
        htmlUrl: pr.htmlUrl,
        state: "OPEN",
        headSha: github.branches.get("repopulse/deps/all"),
        targets: ["requirements.txt#requests@2.32.3"],
        openedAt: NOW,
        closedAt: null,
      });
      return pr.number;
    }

    it("marks merged PRs MERGED", async () => {
      const { deps, prisma, github } = setup({ project: { lastScannedAt: NOW } });
      const number = await withOpenPr(github, prisma);
      github.mergePr(number);
      expect(await processDepsScan(scanJob(), deps)).toMatchObject({ pullRequests: { merged: 1, closed: 0, edited: 0 } });
      expect(prisma.dependencyPullRequest.rows[0]).toMatchObject({ state: "MERGED", closedAt: NOW });
    });

    it("marks closed PRs CLOSED and dismisses their targets until a newer version", async () => {
      const { deps, prisma, github, queues } = setup({ project: { lastScannedAt: NOW } });
      const number = await withOpenPr(github, prisma);
      github.closePr(number);
      await processDepsScan(scanJob(), deps);
      expect(prisma.dependencyPullRequest.rows[0]!.state).toBe("CLOSED");
      expect(rows(prisma).requests).toMatchObject({ status: "DISMISSED", targetVersion: "2.32.3" });
      expect(published(queues.redis)).toContainEqual(expect.objectContaining({ type: "DEPS_PULL_REQUEST_UPDATED", state: "CLOSED", number }));

      // Still dismissed on the next scan…
      await processDepsScan(scanJob(), deps);
      expect(rows(prisma).requests!.status).toBe("DISMISSED");
      // …until a newer version appears.
      deps.registry = fakeRegistry({ "PYPI:requests": [version("2.31.0", 300), version("2.32.3", 40), version("2.33.0", 10)], "PYPI:flask": [] });
      await processDepsScan(scanJob(), deps);
      expect(rows(prisma).requests).toMatchObject({ status: "OUTDATED", targetVersion: "2.33.0" });
    });

    it("flags a PR whose branch someone else pushed to as EDITED and notifies once", async () => {
      const { deps, prisma, github, queues } = setup({ project: { lastScannedAt: NOW } });
      await withOpenPr(github, prisma);
      github.push("repopulse/deps/all", { "README.md": "human change" });
      expect(await processDepsScan(scanJob(), deps)).toMatchObject({ pullRequests: { edited: 1 } });
      expect(prisma.dependencyPullRequest.rows[0]!.state).toBe("EDITED");
      const prJobs = queues.notifyQueue.addBulk.mock.calls.flatMap(([jobs]) => jobs).filter((j) => (j.data as { kind: string }).kind === "pull_request");
      expect(prJobs.map((j) => j.data)).toEqual([expect.objectContaining({ ruleId: "r-deps", event: "edited", prId: "pr1" })]);
      await processDepsScan(scanJob(), deps);
      expect(queues.notifyQueue.addBulk.mock.calls.flatMap(([jobs]) => jobs).filter((j) => (j.data as { kind: string }).kind === "pull_request")).toHaveLength(1);
    });

    it("does not mistake an in-flight bot update for a human edit", async () => {
      const { deps, prisma, github, queues } = setup({ project: { lastScannedAt: NOW } });
      await withOpenPr(github, prisma);
      github.push("repopulse/deps/all", { "requirements.txt": "requests==2.33.0\n" });
      queues.updateQueue.getJob.mockResolvedValue({ getState: async () => "active" } as never);
      await processDepsScan(scanJob(), deps);
      expect(prisma.dependencyPullRequest.rows[0]!.state).toBe("OPEN");
    });

    it.each(["prepared", "previous"])("recovers an exact %s bot push after its update job has exhausted retries", async (headKind) => {
      const { deps, prisma, github, queues } = setup({ project: { updateMode: "AUTO_PR", lastScannedAt: NOW }, app: true, installed: true });
      prisma.dependencyPrOwner.rows.push({ githubRepoId: 42, projectId: "p1" });
      await withOpenPr(github, prisma);
      github.push("repopulse/deps/all", { "requirements.txt": "requests==2.33.0\n" });
      const currentHead = github.branches.get("repopulse/deps/all");
      prisma.dependencyBranchWriteIntent.rows.push({
        projectId: "p1", groupKey: "all",
        commitSha: headKind === "prepared" ? currentHead : "replacement-not-pushed",
        previousHeadSha: headKind === "previous" ? currentHead : null,
      });
      deps.registry = fakeRegistry({ "PYPI:requests": [version("2.31.0", 300), version("2.33.0", 40)], "PYPI:flask": [version("3.0.0")] });
      // BullMQ removed the failed job: it no longer offers in-flight protection.
      expect(await processDepsScan(scanJob(), deps)).toMatchObject({ pullRequests: { edited: 0 }, autoUpdates: 1 });
      expect(prisma.dependencyPullRequest.rows[0]!.state).toBe("OPEN");
      expect(queues.updateQueue.addBulk).toHaveBeenCalledWith([expect.objectContaining({ data: { projectId: "p1", groupKey: "all", trigger: "auto" } })]);
    });

    it("still detects a human push after a pending bot write", async () => {
      const { deps, prisma, github } = setup({ project: { lastScannedAt: NOW } });
      await withOpenPr(github, prisma);
      github.push("repopulse/deps/all", { "requirements.txt": "requests==2.33.0\n" });
      prisma.dependencyBranchWriteIntent.rows.push({ projectId: "p1", groupKey: "all", commitSha: github.branches.get("repopulse/deps/all") });
      github.push("repopulse/deps/all", { "README.md": "human change" });
      expect(await processDepsScan(scanJob(), deps)).toMatchObject({ pullRequests: { edited: 1 } });
      expect(prisma.dependencyPullRequest.rows[0]!.state).toBe("EDITED");
    });
  });

  it("queues deps-update jobs in AUTO_PR mode for groups whose targets changed", async () => {
    const { deps, prisma, queues } = setup({ project: { updateMode: "AUTO_PR", lastScannedAt: NOW }, app: true, installed: true });
    prisma.dependencyPrOwner.rows.push({ githubRepoId: 42, projectId: "p1" });
    expect(await processDepsScan(scanJob(), deps)).toMatchObject({ autoUpdates: 1 });
    expect(queues.updateQueue.addBulk).toHaveBeenCalledWith([
      expect.objectContaining({ data: { projectId: "p1", groupKey: "all", trigger: "auto" }, opts: expect.objectContaining({ jobId: "deps-update-p1-all" }) }),
    ]);

    // An open PR with the same targets: nothing to do.
    prisma.dependencyPullRequest.rows.push({ id: "pr1", projectId: "p1", groupKey: "all", branch: "repopulse/deps/all", number: 9, htmlUrl: "u", state: "OPEN", headSha: "x", targets: ["requirements.txt#requests@2.32.3"] });
    deps.github = { ...(deps.github as object), getPullRequestState: async () => null } as never;
    expect(await processDepsScan(scanJob(), deps)).toMatchObject({ autoUpdates: 0 });
  });
});
