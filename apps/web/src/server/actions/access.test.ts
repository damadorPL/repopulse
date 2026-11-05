import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PENDING_INVITES } from "@/lib/invites";
import { hashInviteToken } from "@/server/invite-tokens";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}

const currentUser = { id: "admin1", isSuperAdmin: true };

const prisma = {
  instanceSettings: { upsert: vi.fn() },
  invite: { count: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
};

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

const { getCurrentUserOrThrow } = await import("@/lib/auth");
const { createInviteAction, deleteInviteAction, setPublicRegistrationAction } = await import("./access");

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.isSuperAdmin = true;
  vi.mocked(getCurrentUserOrThrow).mockResolvedValue(currentUser as never);
});

describe("super admin guard across access actions", () => {
  it("returns FORBIDDEN for regular users and UNAUTHORIZED when signed out", async () => {
    currentUser.isSuperAdmin = false;
    expect(await setPublicRegistrationAction({ enabled: false })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await createInviteAction({ expiresInDays: 7 })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await deleteInviteAction({ inviteId: "inv1" })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });

    vi.mocked(getCurrentUserOrThrow).mockRejectedValue(new UnauthorizedError("Not signed in"));
    expect(await setPublicRegistrationAction({ enabled: true })).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
    expect(await createInviteAction({ expiresInDays: 7 })).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
    expect(await deleteInviteAction({ inviteId: "inv1" })).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
  });
});

describe("setPublicRegistrationAction", () => {
  it("upserts publicRegistration setting", async () => {
    prisma.instanceSettings.upsert.mockResolvedValueOnce({ publicRegistration: false });
    const result = await setPublicRegistrationAction({ enabled: false });
    expect(result).toEqual({ ok: true, data: { enabled: false } });
    expect(prisma.instanceSettings.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      create: { id: 1, publicRegistration: false },
      update: { publicRegistration: false },
      select: { publicRegistration: true },
    });
  });
});

describe("createInviteAction", () => {
  it("returns CONFLICT when MAX_PENDING_INVITES is reached", async () => {
    prisma.invite.count.mockResolvedValueOnce(MAX_PENDING_INVITES);
    const result = await createInviteAction({ expiresInDays: 7 });
    expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(prisma.invite.create).not.toHaveBeenCalled();
  });

  it("stores hashInviteToken(token) and returns the raw token and InviteView", async () => {
    prisma.invite.count.mockResolvedValueOnce(0);
    prisma.invite.create.mockImplementationOnce(async ({ data }) => ({
      id: "inv1",
      note: data.note,
      expiresAt: data.expiresAt,
      usedAt: null,
      createdAt: new Date("2026-11-01T00:00:00Z"),
      createdBy: { name: "Admin", email: "admin@example.com" },
      usedBy: null,
    }));

    const result = await createInviteAction({ note: "  For Alice  ", expiresInDays: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { token, invite } = result.data;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invite).toMatchObject({
      id: "inv1",
      note: "For Alice",
      status: "pending",
      createdBy: "Admin",
    });
    expect(prisma.invite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenHash: hashInviteToken(token),
          note: "For Alice",
          createdById: "admin1",
        }),
      }),
    );
  });
});

describe("deleteInviteAction", () => {
  it("returns NOT_FOUND when count is 0 and ok(null) when deleted", async () => {
    prisma.invite.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await deleteInviteAction({ inviteId: "inv-missing" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });

    prisma.invite.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await deleteInviteAction({ inviteId: "inv1" })).toEqual({ ok: true, data: null });
  });
});
