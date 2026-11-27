import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}
class InvalidRepositoryInputError extends Error {}
class GitHubRepositoryNotFoundError extends Error {}
class GitHubRateLimitError extends Error {}

const decryptToken = vi.fn();
const findUniqueUser = vi.fn();

vi.mock("@/lib/auth", () => ({ UnauthorizedError, ForbiddenError }));
vi.mock("@repopulse/db", () => ({ decryptToken, prisma: { user: { findUnique: findUniqueUser } } }));
vi.mock("@repopulse/github", () => ({
  InvalidRepositoryInputError,
  GitHubRepositoryNotFoundError,
  GitHubRateLimitError,
}));

const { fail, getGitHubToken, invalidInput, isUniqueConstraintError, loadGitHubToken, ok, toActionError } =
  await import("./action-result");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("ok, fail, invalidInput, isUniqueConstraintError", () => {
  it("constructs ActionResult objects and checks P2002", () => {
    expect(ok(42)).toEqual({ ok: true, data: 42 });
    expect(fail("NOT_FOUND", "Missing")).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Missing" },
    });

    const parsed = z.string().min(3, "Too short").safeParse("a");
    if (!parsed.success) {
      expect(invalidInput(parsed.error)).toEqual({
        ok: false,
        error: { code: "INVALID_INPUT", message: "Too short" },
      });
    }

    expect(isUniqueConstraintError({ code: "P2002" })).toBe(true);
    expect(isUniqueConstraintError({ code: "P2025" })).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });
});

describe("toActionError", () => {
  it("maps known error classes to their ActionErrorCode and redacts unknown errors", () => {
    expect(toActionError(new UnauthorizedError("Sign in"), "test")).toEqual({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "Sign in" },
    });
    expect(toActionError(new ForbiddenError("Admins only"), "test")).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "Admins only" },
    });
    expect(toActionError(new InvalidRepositoryInputError("Bad slug"), "test")).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: "Bad slug" },
    });
    expect(toActionError(new GitHubRepositoryNotFoundError("No repo"), "test")).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "No repo" },
    });
    expect(toActionError(new GitHubRateLimitError("Slow down"), "test")).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: "Slow down" },
    });

    const unknown = toActionError(new Error("internal stack trace secret"), "test");
    expect(unknown).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "Something went wrong. Please try again." },
    });
  });
});

describe("getGitHubToken", () => {
  it("returns undefined on null or corrupt ciphertext and returns plaintext when readable", () => {
    expect(getGitHubToken({ id: "u1", githubAccessTokenEncrypted: null }, "test")).toBeUndefined();
    expect(decryptToken).not.toHaveBeenCalled();

    decryptToken.mockImplementationOnce(() => {
      throw new Error("bad key");
    });
    expect(getGitHubToken({ id: "u1", githubAccessTokenEncrypted: "corrupt" }, "test")).toBeUndefined();

    decryptToken.mockReturnValueOnce("ghp_plain");
    expect(getGitHubToken({ id: "u1", githubAccessTokenEncrypted: "enc" }, "test")).toBe("ghp_plain");
  });
});

describe("loadGitHubToken", () => {
  it("uses already-present ciphertext without querying and lazily queries when null", async () => {
    decryptToken.mockReturnValueOnce("ghp_inline");
    await expect(loadGitHubToken({ id: "u1", githubAccessTokenEncrypted: "enc1" }, "test")).resolves.toBe("ghp_inline");
    expect(findUniqueUser).not.toHaveBeenCalled();

    findUniqueUser.mockResolvedValueOnce({ githubAccessTokenEncrypted: "enc2" });
    decryptToken.mockReturnValueOnce("ghp_db");
    await expect(loadGitHubToken({ id: "u2", githubAccessTokenEncrypted: null }, "test")).resolves.toBe("ghp_db");
    expect(findUniqueUser).toHaveBeenCalledWith({
      where: { id: "u2" },
      select: { githubAccessTokenEncrypted: true },
    });

    findUniqueUser.mockResolvedValueOnce(null);
    await expect(loadGitHubToken({ id: "u3", githubAccessTokenEncrypted: null }, "test")).resolves.toBeUndefined();
  });
});
