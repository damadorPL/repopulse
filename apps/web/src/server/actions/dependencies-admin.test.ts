import { beforeEach, describe, expect, it, vi } from "vitest";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}

const currentUser = { id: "u1", isSuperAdmin: true };
const prisma = { instanceSettings: { upsert: vi.fn() } };

vi.mock("@/lib/auth", () => ({
  UnauthorizedError,
  ForbiddenError,
  getCurrentUserOrThrow: vi.fn(async () => currentUser),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@repopulse/db", () => ({ prisma, INSTANCE_SETTINGS_ID: 1 }));
vi.mock("@repopulse/github", () => ({
  GitHubRateLimitError: class extends Error {},
  GitHubRepositoryNotFoundError: class extends Error {},
  InvalidRepositoryInputError: class extends Error {},
}));

const { readDepsEnabledCached } = await import("@/server/deps-enabled-cache");
const { setDepsEnabledAction } = await import("./dependencies-admin");

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.isSuperAdmin = true;
});

describe("setDepsEnabledAction", () => {
  it("turns the module on and off and invalidates the depsEnabled cache", async () => {
    await expect(readDepsEnabledCached(async () => false)).resolves.toBe(false);
    await expect(setDepsEnabledAction({ enabled: true })).resolves.toEqual({ ok: true, data: { enabled: true } });
    await expect(readDepsEnabledCached(async () => true)).resolves.toBe(true);
    expect(prisma.instanceSettings.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      create: { id: 1, depsEnabled: true },
      update: { depsEnabled: true },
    });
    await expect(setDepsEnabledAction({ enabled: false })).resolves.toEqual({ ok: true, data: { enabled: false } });
  });

  it("is super admin only", async () => {
    currentUser.isSuperAdmin = false;
    await expect(setDepsEnabledAction({ enabled: true })).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(prisma.instanceSettings.upsert).not.toHaveBeenCalled();
  });

  it("validates the input", async () => {
    await expect(setDepsEnabledAction({ enabled: "yes" } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    await expect(setDepsEnabledAction({ enabled: true, extra: 1 } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(prisma.instanceSettings.upsert).not.toHaveBeenCalled();
  });
});
