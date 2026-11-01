import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = {
  invite: { updateMany: vi.fn(), update: vi.fn() },
  user: { create: vi.fn() },
};
const prisma = {
  user: { findUnique: vi.fn(), count: vi.fn(), create: vi.fn() },
  instanceSettings: { findUnique: vi.fn() },
  invite: { findFirst: vi.fn() },
  $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
};
vi.mock("@repopulse/db", () => ({ prisma, INSTANCE_SETTINGS_ID: 1 }));

const { admitGitHubUser, INVITE_INVALID_REDIRECT, INVITE_REQUIRED_REDIRECT } = await import("./registration");
const { generateInviteToken, hashInviteToken } = await import("./invite-tokens");

const fields = {
  githubId: "42",
  email: "new@example.com",
  name: "New User",
  avatarUrl: null,
  githubAccessTokenEncrypted: "enc",
};

function setup({ existing = false, users = 3, open = true } = {}) {
  prisma.user.findUnique.mockResolvedValue(existing ? { id: "u_existing" } : null);
  prisma.user.count.mockResolvedValue(users);
  prisma.instanceSettings.findUnique.mockResolvedValue({ publicRegistration: open });
  tx.user.create.mockResolvedValue({ id: "u_new" });
}

beforeEach(() => vi.clearAllMocks());

describe("admitGitHubUser", () => {
  it("always lets existing users in, even when invite-only", async () => {
    setup({ existing: true, open: false });
    await expect(admitGitHubUser(fields, undefined)).resolves.toBe(true);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("creates the first account as the super admin", async () => {
    setup({ users: 0, open: false });
    await expect(admitGitHubUser(fields, undefined)).resolves.toBe(true);
    expect(prisma.user.create).toHaveBeenCalledWith({ data: { ...fields, isSuperAdmin: true } });
  });

  it("lets new users in while public registration is open (jwt callback creates them)", async () => {
    setup({ open: true });
    await expect(admitGitHubUser(fields, undefined)).resolves.toBe(true);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("refuses new users without an invite when invite-only", async () => {
    setup({ open: false });
    await expect(admitGitHubUser(fields, undefined)).resolves.toBe(INVITE_REQUIRED_REDIRECT);
    await expect(admitGitHubUser(fields, "not-a-token")).resolves.toBe(INVITE_REQUIRED_REDIRECT);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("claims a usable invite and creates the account in one transaction", async () => {
    setup({ open: false });
    tx.invite.updateMany.mockResolvedValue({ count: 1 });
    const token = generateInviteToken();

    await expect(admitGitHubUser(fields, token)).resolves.toBe(true);

    const tokenHash = hashInviteToken(token);
    expect(tx.invite.updateMany).toHaveBeenCalledWith({
      where: { tokenHash, usedAt: null, expiresAt: { gt: expect.any(Date) } },
      data: { usedAt: expect.any(Date) },
    });
    expect(tx.user.create).toHaveBeenCalledWith({ data: fields, select: { id: true } });
    expect(tx.invite.update).toHaveBeenCalledWith({ where: { tokenHash }, data: { usedById: "u_new" } });
  });

  it("refuses a used, expired or revoked invite when invite-only", async () => {
    setup({ open: false });
    tx.invite.updateMany.mockResolvedValue({ count: 0 });
    await expect(admitGitHubUser(fields, generateInviteToken())).resolves.toBe(INVITE_INVALID_REDIRECT);
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it("falls back to open sign-up when the invite is stale but registration is public", async () => {
    setup({ open: true });
    tx.invite.updateMany.mockResolvedValue({ count: 0 });
    await expect(admitGitHubUser(fields, generateInviteToken())).resolves.toBe(true);
  });

  it("treats a missing settings row as open registration", async () => {
    setup();
    prisma.instanceSettings.findUnique.mockResolvedValue(null);
    await expect(admitGitHubUser(fields, undefined)).resolves.toBe(true);
  });
});
