import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = {
  invite: { updateMany: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn(), count: vi.fn(), create: vi.fn() },
  $executeRaw: vi.fn(),
};
const prisma = {
  user: tx.user,
  instanceSettings: { findUnique: vi.fn() },
  invite: { findFirst: vi.fn() },
  $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
};
vi.mock("@repopulse/db", () => ({ prisma, INSTANCE_SETTINGS_ID: 1 }));

const { admitGitHubUser, findUsableInvite, INVITE_INVALID_REDIRECT, INVITE_REQUIRED_REDIRECT } = await import("./registration");
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

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation(async (fn) => fn(tx));
  tx.$executeRaw.mockResolvedValue(0);
});

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
    expect(tx.$executeRaw).toHaveBeenCalledBefore(tx.user.count);
  });

  it("admits only one bootstrap admin when initial callbacks overlap", async () => {
    setup({ users: 0, open: false });
    const created: Array<typeof fields & { isSuperAdmin?: boolean }> = [];
    let previous = Promise.resolve();
    // Model the transaction lock: the next transaction observes committed users.
    prisma.$transaction.mockImplementation((fn) => {
      const result = previous.then(() => fn(tx));
      previous = result.then(() => undefined);
      return result;
    });
    tx.user.count.mockImplementation(async () => created.length);
    tx.user.create.mockImplementation(async ({ data }) => {
      created.push(data);
      return { id: data.githubId };
    });

    const results = await Promise.all([
      admitGitHubUser(fields, undefined),
      admitGitHubUser({ ...fields, githubId: "43", email: "second@example.com" }, undefined),
    ]);
    expect(results).toEqual([true, INVITE_REQUIRED_REDIRECT]);
    expect(created).toEqual([{ ...fields, isSuperAdmin: true }]);
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
    expect(prisma.user.create).not.toHaveBeenCalled();
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

describe("findUsableInvite", () => {
  it("skips the database query for malformed tokens and queries unused, unexpired invites for valid tokens", async () => {
    await expect(findUsableInvite("bad-token")).resolves.toBeNull();
    expect(prisma.invite.findFirst).not.toHaveBeenCalled();

    const token = generateInviteToken();
    const row = {
      id: "inv1",
      expiresAt: new Date("2026-12-01T00:00:00Z"),
      createdBy: { name: "Admin", email: "admin@example.com" },
    };
    prisma.invite.findFirst.mockResolvedValueOnce(row);

    await expect(findUsableInvite(token)).resolves.toEqual(row);
    expect(prisma.invite.findFirst).toHaveBeenCalledWith({
      where: {
        tokenHash: hashInviteToken(token),
        usedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      select: { id: true, expiresAt: true, createdBy: { select: { name: true, email: true } } },
    });
  });
});
