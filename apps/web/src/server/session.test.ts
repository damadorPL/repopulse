import { beforeEach, describe, expect, it, vi } from "vitest";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {
  constructor() {
    super("Administrator access is required.");
  }
}

class RedirectError extends Error {
  url: string;
  constructor(url: string) {
    super(`NEXT_REDIRECT:${url}`);
    this.url = url;
  }
}

class NotFoundError extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}

const getCurrentUserOrThrow = vi.fn();
const redirect = vi.fn((url: string) => {
  throw new RedirectError(url);
});
const notFound = vi.fn(() => {
  throw new NotFoundError();
});

vi.mock("@/lib/auth", () => ({
  UnauthorizedError,
  ForbiddenError,
  getCurrentUserOrThrow,
}));
vi.mock("next/navigation", () => ({ redirect, notFound }));

const { getSuperAdminOrThrow, requireSuperAdmin, requireUser } = await import("./session");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireUser", () => {
  it("returns the signed-in user", async () => {
    const user = { id: "u1", isSuperAdmin: false };
    getCurrentUserOrThrow.mockResolvedValueOnce(user);
    await expect(requireUser()).resolves.toBe(user);
  });

  it("redirects to /login on UnauthorizedError and rethrows unexpected errors", async () => {
    getCurrentUserOrThrow.mockRejectedValueOnce(new UnauthorizedError("Not signed in"));
    await expect(requireUser()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");

    getCurrentUserOrThrow.mockRejectedValueOnce(new Error("DB error"));
    await expect(requireUser()).rejects.toThrow("DB error");
  });
});

describe("requireSuperAdmin", () => {
  it("returns the user when isSuperAdmin is true and calls notFound() when false", async () => {
    const admin = { id: "admin1", isSuperAdmin: true };
    getCurrentUserOrThrow.mockResolvedValueOnce(admin);
    await expect(requireSuperAdmin()).resolves.toBe(admin);

    getCurrentUserOrThrow.mockResolvedValueOnce({ id: "u1", isSuperAdmin: false });
    await expect(requireSuperAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});

describe("getSuperAdminOrThrow", () => {
  it("returns the super admin or throws ForbiddenError for regular users", async () => {
    const admin = { id: "admin1", isSuperAdmin: true };
    getCurrentUserOrThrow.mockResolvedValueOnce(admin);
    await expect(getSuperAdminOrThrow()).resolves.toBe(admin);

    getCurrentUserOrThrow.mockResolvedValueOnce({ id: "u1", isSuperAdmin: false });
    await expect(getSuperAdminOrThrow()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
