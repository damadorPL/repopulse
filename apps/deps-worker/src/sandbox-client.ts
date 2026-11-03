import {
  compareVersions,
  lockRequestSchema,
  lockResponseSchema,
  MAX_LOCKFILE_BYTES,
  MAX_SANDBOX_BODY_BYTES,
  readLockfile,
  sandboxHealthSchema,
  type DependencyEcosystem,
  type LockErrorCode,
  type LockRequest,
  type PackageManager,
  type SandboxHealth,
} from "@repopulse/deps";

/**
 * HTTP client of `deps-sandbox` (Slice 08 §3.10.1): `POST /v1/lock` with the bearer token, a timeout above the
 * sandbox's own (300 s), zod validation of the response, plus the worker-side checks of the returned lockfile
 * (§3.9 step 5). The token is never logged and never part of an error message.
 */

/** Above `DEPS_SANDBOX_TIMEOUT_MS` (300 s), so the sandbox reports its own timeout first. */
export const SANDBOX_LOCK_TIMEOUT_MS = 330_000;
export const SANDBOX_HEALTH_TIMEOUT_MS = 3_000;
/** base64 inflates by 4/3; plus JSON framing. */
const MAX_RESPONSE_BYTES = Math.ceil((MAX_LOCKFILE_BYTES * 4) / 3) + 64 * 1024;

/** The sandbox runs one job at a time and answered 503 `BUSY`: retry the job later (BullMQ backoff). */
export class SandboxBusyError extends Error {
  constructor() {
    super("The lockfile sandbox is busy with another job.");
    this.name = "SandboxBusyError";
  }
}

/** Unreachable, timed out, or answered something that is not the contract. Transient: retried. */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/**
 * The sandbox could not produce a lockfile (`ok: false`), or its lockfile failed validation. Permanent. `message`
 * is user-safe; `stderrTail` goes to the job log only, never into a PR or an SSE event.
 */
export class SandboxLockError extends Error {
  constructor(
    readonly code: LockErrorCode | "INVALID_LOCKFILE",
    message: string,
    readonly stderrTail: string = "",
  ) {
    super(message);
    this.name = "SandboxLockError";
  }
}

const USER_MESSAGES: Record<LockErrorCode, string> = {
  BAD_REQUEST: "The lockfile sandbox rejected the request.",
  UNAUTHORIZED: "The lockfile sandbox rejected the worker's token (check DEPS_SANDBOX_TOKEN).",
  BUSY: "The lockfile sandbox is busy.",
  TOO_LARGE: "The project is too large for lockfile regeneration.",
  UNSUPPORTED_REGISTRY: "The project uses a custom package registry, which lockfile regeneration does not support.",
  UNSUPPORTED_TOOL_VERSION: "The project needs a package manager version the sandbox does not provide.",
  TIMEOUT: "Regenerating the lockfile timed out.",
  COMMAND_FAILED: "The package manager could not regenerate the lockfile with these versions.",
  LOCKFILE_MISSING: "The package manager did not write a lockfile.",
  INTERNAL: "The lockfile sandbox failed.",
};

export interface SandboxClient {
  /** Returns the new lockfile text (decoded); throws the errors above. */
  lock(request: LockRequest, signal?: AbortSignal): Promise<{ path: string; text: string }>;
  /** `GET /health`; `null` when unreachable or malformed. */
  health(): Promise<SandboxHealth | null>;
}

export interface SandboxClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function createSandboxClient(options: SandboxClientOptions): SandboxClient {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");

  return {
    async lock(request, signal) {
      const parsed = lockRequestSchema.safeParse(request);
      if (!parsed.success) throw new SandboxLockError("BAD_REQUEST", "The lockfile request is invalid.");
      const body = JSON.stringify(parsed.data);
      if (Buffer.byteLength(body) > MAX_SANDBOX_BODY_BYTES) {
        throw new SandboxLockError("TOO_LARGE", USER_MESSAGES.TOO_LARGE);
      }
      let response: Response;
      try {
        response = await fetchImpl(`${base}/v1/lock`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.token}` },
          body,
          signal: withTimeout(options.timeoutMs ?? SANDBOX_LOCK_TIMEOUT_MS, signal),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new SandboxUnavailableError(timedOut ? "The lockfile sandbox did not answer in time." : "The lockfile sandbox is unreachable.");
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new SandboxLockError("INVALID_LOCKFILE", "The regenerated lockfile is too large.");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        if (response.status === 503) throw new SandboxBusyError();
        throw new SandboxUnavailableError(`The lockfile sandbox answered HTTP ${response.status} without a valid body.`);
      }
      const result = lockResponseSchema.safeParse(json);
      if (!result.success) {
        if (response.status === 503) throw new SandboxBusyError();
        throw new SandboxUnavailableError(`The lockfile sandbox answered HTTP ${response.status} outside the contract.`);
      }
      const data = result.data;
      if (!data.ok) {
        if (data.code === "BUSY") throw new SandboxBusyError();
        throw new SandboxLockError(data.code, USER_MESSAGES[data.code], data.stderrTail);
      }
      if (!response.ok) throw new SandboxUnavailableError(`The lockfile sandbox answered HTTP ${response.status}.`);
      const bytes = Buffer.from(data.lockfile.contentBase64, "base64");
      if (bytes.byteLength > MAX_LOCKFILE_BYTES) throw new SandboxLockError("INVALID_LOCKFILE", "The regenerated lockfile is too large.");
      return { path: data.lockfile.path, text: bytes.toString("utf8") };
    },

    async health() {
      try {
        const response = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(SANDBOX_HEALTH_TIMEOUT_MS) });
        if (!response.ok) return null;
        const parsed = sandboxHealthSchema.safeParse(await response.json());
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}

export interface LockfileExpectation {
  packageManager: PackageManager;
  /** The lockfile path the request asked for. */
  expectLockfile: string;
  /** `formatVersion` read from the current lockfile (must be kept). */
  inputFormatVersion: string | null;
  /** Each importer (manifest) whose planned upgrades must resolve to their targets. */
  importers: ReadonlyArray<{
    importer: string;
    ecosystem: DependencyEcosystem;
    dependencies: ReadonlyArray<{ name: string; declared: string }>;
    expected: ReadonlyArray<{ name: string; version: string }>;
  }>;
}

/**
 * Worker-side validation of a sandbox lockfile (§3.9 step 5): only the expected path, ≤ 20 MiB, parses with the
 * §3.2 readers, the same format version as the input, and every planned dependency resolves to its target.
 * Throws {@link SandboxLockError} (`INVALID_LOCKFILE`) otherwise.
 */
export function validateLockfile(result: { path: string; text: string }, expectation: LockfileExpectation): void {
  const fail = (detail: string): never => {
    throw new SandboxLockError("INVALID_LOCKFILE", `The regenerated lockfile was rejected: ${detail}.`);
  };
  if (result.path !== expectation.expectLockfile) fail(`unexpected path ${JSON.stringify(result.path)}`);
  if (Buffer.byteLength(result.text) > MAX_LOCKFILE_BYTES) fail("it is larger than 20 MiB");
  for (const importer of expectation.importers) {
    const read = readLockfile({
      packageManager: expectation.packageManager,
      lockfilePath: expectation.expectLockfile,
      text: result.text,
      importer: importer.importer,
      dependencies: importer.dependencies,
    });
    if (read.warnings.length > 0) fail("it could not be parsed");
    if (read.formatVersion !== expectation.inputFormatVersion) {
      fail(`its format changed from ${expectation.inputFormatVersion ?? "unknown"} to ${read.formatVersion ?? "unknown"}`);
    }
    for (const planned of importer.expected) {
      const resolved = read.versions.get(planned.name);
      if (!resolved || compareVersions(importer.ecosystem, resolved, planned.version) !== 0) {
        fail(`${planned.name} resolves to ${resolved ?? "nothing"} instead of ${planned.version}`);
      }
    }
  }
}
