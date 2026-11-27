import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = {
  invite: { updateMany: vi.fn() },
  user: { findFirst: vi.fn() },
  instanceSettings: { findUnique: vi.fn() },
  $executeRaw: vi.fn(),
};
const prisma = {
  user: tx.user,
  instanceSettings: tx.instanceSettings,
  invite: { findFirst: vi.fn() },
  $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
};
vi.mock("@repopulse/db", () => ({ prisma, INSTANCE_SETTINGS_ID: 1 }));

const { admitNewGitHubUser, findUsableInvite, INVITE_INVALID_REDIRECT, INVITE_REQUIRED_REDIRECT } =
  await import("./registration");
const { generateInviteToken, hashInviteToken } = await import("./invite-tokens");

function setup({ users = 3, open = true } = {}) {
  tx.user.findFirst.mockResolvedValue(users > 0 ? { id: "u1" } : null);
  tx.instanceSettings.findUnique.mockResolvedValue({ publicRegistration: open });
}

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation(async (fn) => fn(tx));
  tx.$executeRaw.mockResolvedValue(0);
});

describe("admitNewGitHubUser", () => {
  it("admits the first account as super admin after acquiring the advisory lock", async () => {
    setup({ users: 0, open: false });
    await expect(admitNewGitHubUser(undefined)).resolves.toEqual({
      admitted: true,
      isSuperAdmin: true,
      claimedInviteTokenHash: null,
    });
    expect(tx.$executeRaw).toHaveBeenCalledBefore(tx.user.findFirst);
  });

  it("admits only one bootstrap admin when initial callbacks overlap", async () => {
    let userCount = 0;
    tx.instanceSettings.findUnique.mockResolvedValue({ publicRegistration: false });
    let previous = Promise.resolve();
    // Model the transaction + advisory lock: the next transaction observes committed users.
    prisma.$transaction.mockImplementation((fn) => {
      const result = previous.then(async () => {
        const res = await fn(tx);
        if (res && typeof res === "object" && "admitted" in res && res.admitted) {
          userCount += 1;
        }
        return res;
      });
      previous = result.then(() => undefined);
      return result;
    });
    tx.user.findFirst.mockImplementation(async () => (userCount > 0 ? { id: "u1" } : null));

    const results = await Promise.all([admitNewGitHubUser(undefined), admitNewGitHubUser(undefined)]);
    expect(results).toEqual([
      { admitted: true, isSuperAdmin: true, claimedInviteTokenHash: null },
      { admitted: false, errorCode: "InviteRequired", redirectTo: INVITE_REQUIRED_REDIRECT },
    ]);
  });

  it("lets new users in as non-admin while public registration is open", async () => {
    setup({ open: true });
    await expect(admitNewGitHubUser(undefined)).resolves.toEqual({
      admitted: true,
      isSuperAdmin: false,
      claimedInviteTokenHash: null,
    });
  });

  it("refuses new users without an invite when invite-only", async () => {
    setup({ open: false });
    await expect(admitNewGitHubUser(undefined)).resolves.toEqual({
      admitted: false,
      errorCode: "InviteRequired",
      redirectTo: INVITE_REQUIRED_REDIRECT,
    });
    await expect(admitNewGitHubUser("not-a-token")).resolves.toEqual({
      admitted: false,
      errorCode: "InviteRequired",
      redirectTo: INVITE_REQUIRED_REDIRECT,
    });
  });

  it("claims a usable invite atomically and returns its tokenHash", async () => {
    setup({ open: false });
    tx.invite.updateMany.mockResolvedValue({ count: 1 });
    const token = generateInviteToken();

    await expect(admitNewGitHubUser(token)).resolves.toEqual({
      admitted: true,
      isSuperAdmin: false,
      claimedInviteTokenHash: hashInviteToken(token),
    });

    expect(tx.invite.updateMany).toHaveBeenCalledWith({
      where: { tokenHash: hashInviteToken(token), usedAt: null, expiresAt: { gt: expect.any(Date) } },
      data: { usedAt: expect.any(Date) },
    });
  });

  it("refuses a used, expired or revoked invite when invite-only", async () => {
    setup({ open: false });
    tx.invite.updateMany.mockResolvedValue({ count: 0 });
    await expect(admitNewGitHubUser(generateInviteToken())).resolves.toEqual({
      admitted: false,
      errorCode: "InviteInvalid",
      redirectTo: INVITE_INVALID_REDIRECT,
    });
  });

  it("falls back to open sign-up when the invite is stale but registration is public", async () => {
    setup({ open: true });
    tx.invite.updateMany.mockResolvedValue({ count: 0 });
    await expect(admitNewGitHubUser(generateInviteToken())).resolves.toEqual({
      admitted: true,
      isSuperAdmin: false,
      claimedInviteTokenHash: null,
    });
  });

  it("treats a missing settings row as open registration", async () => {
    setup();
    tx.instanceSettings.findUnique.mockResolvedValue(null);
    await expect(admitNewGitHubUser(undefined)).resolves.toEqual({
      admitted: true,
      isSuperAdmin: false,
      claimedInviteTokenHash: null,
    });
  });

  it("reuses an active transaction client without starting a nested $transaction", async () => {
    setup({ users: 0, open: false });
    await expect(admitNewGitHubUser(undefined, tx)).resolves.toEqual({
      admitted: true,
      isSuperAdmin: true,
      claimedInviteTokenHash: null,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
