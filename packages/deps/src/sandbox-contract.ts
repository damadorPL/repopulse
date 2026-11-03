/**
 * Contract between `apps/deps-worker` (client) and `apps/deps-sandbox` (server), Slice 08 §3.10.
 * Validated with zod on both sides. The sandbox never sees tokens: only manifests, lockfiles and workspace files.
 *
 * `POST /v1/lock` with `Authorization: Bearer <DEPS_SANDBOX_TOKEN>`.
 */
import { z } from "zod";
import { MAX_SANDBOX_FILES } from "./limits.js";

/** Package managers whose lockfile the sandbox can regenerate. */
export const SANDBOX_PACKAGE_MANAGERS = ["NPM", "PNPM", "BUN", "UV", "POETRY"] as const;
export type SandboxPackageManager = (typeof SANDBOX_PACKAGE_MANAGERS)[number];

/** Repo-relative POSIX path: no leading `/`, no `..` segment, no backslash, no NUL. */
const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.includes("\0") &&
      !/^[A-Za-z]:/.test(p) &&
      p.split("/").every((segment) => segment !== ".." && segment !== "." && segment !== ""),
    { message: "must be a normalized repo-relative path" },
  );

/** `""` = repository root. */
const workdirPath = z.union([z.literal(""), relativePath]);

export const sandboxFileSchema = z.object({ path: relativePath, contentBase64: z.string() }).strict();
export type SandboxFile = z.infer<typeof sandboxFileSchema>;

export const lockRequestSchema = z
  .object({
    packageManager: z.enum(SANDBOX_PACKAGE_MANAGERS),
    /** Workspace root (where the lockfile lives), relative to the uploaded tree. */
    workdir: workdirPath,
    files: z.array(sandboxFileSchema).min(1).max(MAX_SANDBOX_FILES),
    /** Planned upgrades (uv: `--upgrade-package name==version`; npm / pnpm `LOCKFILE_ONLY`: `update <name>`). */
    upgrade: z
      .array(z.object({ name: z.string().min(1).max(214), version: z.string().min(1).max(128) }).strict())
      .max(1000),
    /** `true` with `LOCKFILE_ONLY` (ranges unchanged): npm / pnpm run `update <name>…` instead of `install`. */
    lockfileOnly: z.boolean().default(false),
    /** Repo-relative path of the lockfile the worker expects back (e.g. `pnpm-lock.yaml`, `apps/x/uv.lock`). */
    expectLockfile: relativePath,
  })
  .strict();
export type LockRequest = z.input<typeof lockRequestSchema>;
export type ParsedLockRequest = z.output<typeof lockRequestSchema>;

export const LOCK_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "BUSY",
  "TOO_LARGE",
  "UNSUPPORTED_REGISTRY",
  "UNSUPPORTED_TOOL_VERSION",
  "TIMEOUT",
  "COMMAND_FAILED",
  "LOCKFILE_MISSING",
  "INTERNAL",
] as const;
export type LockErrorCode = (typeof LOCK_ERROR_CODES)[number];

export const lockResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), lockfile: sandboxFileSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(LOCK_ERROR_CODES),
      /** Sanitized tail of the tool's stderr (≤ 2 KB). Goes to the job log, never into a PR. */
      stderrTail: z.string().max(4096).default(""),
    })
    .strict(),
]);
export type LockResponse = z.input<typeof lockResponseSchema>;
export type ParsedLockResponse = z.output<typeof lockResponseSchema>;

/** `GET /health` (no auth). */
export const sandboxHealthSchema = z.object({
  status: z.literal("ok"),
  tools: z.record(z.string(), z.string()),
});
export type SandboxHealth = z.infer<typeof sandboxHealthSchema>;
