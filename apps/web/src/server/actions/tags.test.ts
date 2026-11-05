import { beforeEach, describe, expect, it, vi } from "vitest";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}

const currentUser = { id: "u1" };

const prisma = {
  tag: {
    create: vi.fn(),
    updateMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
  },
  userSubscription: { findFirst: vi.fn() },
  subscriptionTag: { deleteMany: vi.fn(), createMany: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: typeof prisma) => unknown) => fn(prisma)),
};

vi.mock("@/lib/auth", () => ({
  UnauthorizedError,
  ForbiddenError,
  getCurrentUserOrThrow: vi.fn(async () => currentUser),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@repopulse/db", () => ({ prisma }));
vi.mock("@repopulse/github", () => ({
  GitHubRateLimitError: class extends Error {},
  GitHubRepositoryNotFoundError: class extends Error {},
  InvalidRepositoryInputError: class extends Error {},
}));

const { assignTagsAction, createTagAction, deleteTagAction, updateTagAction } = await import("./tags");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createTagAction", () => {
  it("trims name, uppercases hex color, derives slug", async () => {
    prisma.tag.create.mockImplementationOnce(async ({ data }) => ({ id: "t1", ...data }));
    const result = await createTagAction({ name: "  Front End  ", colorHex: "#ef4444" });
    expect(result).toEqual({
      ok: true,
      data: { id: "t1", userId: "u1", name: "Front End", slug: "front-end", colorHex: "#EF4444" },
    });
    expect(prisma.tag.create).toHaveBeenCalledWith({
      data: { userId: "u1", name: "Front End", slug: "front-end", colorHex: "#EF4444" },
      select: { id: true, name: true, slug: true, colorHex: true },
    });
  });

  it("maps P2002 unique constraint error to CONFLICT", async () => {
    prisma.tag.create.mockRejectedValueOnce({ code: "P2002" });
    const result = await createTagAction({ name: "Core", colorHex: "#EF4444" });
    expect(result).toEqual({
      ok: false,
      error: { code: "CONFLICT", message: 'You already have a tag named "Core".' },
    });
  });
});

describe("updateTagAction", () => {
  it("returns INVALID_INPUT when nothing is provided to update", async () => {
    const result = await updateTagAction({ tagId: "t1" });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(prisma.tag.updateMany).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for another user's tag", async () => {
    prisma.tag.updateMany.mockResolvedValueOnce({ count: 0 });
    const result = await updateTagAction({ tagId: "t-other", name: "Renamed" });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(prisma.tag.updateMany).toHaveBeenCalledWith({
      where: { id: "t-other", userId: "u1" },
      data: { name: "Renamed", slug: "renamed" },
    });
  });

  it("keeps existing slug on color-only update", async () => {
    prisma.tag.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.tag.findUniqueOrThrow.mockResolvedValueOnce({
      id: "t1",
      name: "Core",
      slug: "core",
      colorHex: "#10B981",
    });

    const result = await updateTagAction({ tagId: "t1", colorHex: "#10b981" });
    expect(result).toEqual({
      ok: true,
      data: { id: "t1", name: "Core", slug: "core", colorHex: "#10B981" },
    });
    expect(prisma.tag.updateMany).toHaveBeenCalledWith({
      where: { id: "t1", userId: "u1" },
      data: { colorHex: "#10B981" },
    });
  });

  it("maps P2002 unique constraint error to CONFLICT", async () => {
    prisma.tag.updateMany.mockRejectedValueOnce({ code: "P2002" });
    const result = await updateTagAction({ tagId: "t1", name: "Duplicate" });
    expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });
});

describe("deleteTagAction", () => {
  it("deletes scoped by userId and returns NOT_FOUND when count is 0", async () => {
    prisma.tag.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await deleteTagAction({ tagId: "t-other" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(prisma.tag.deleteMany).toHaveBeenCalledWith({ where: { id: "t-other", userId: "u1" } });

    prisma.tag.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await deleteTagAction({ tagId: "t1" })).toEqual({ ok: true, data: { tagId: "t1" } });
  });
});

describe("assignTagsAction", () => {
  it("returns NOT_FOUND when subscription belongs to another user", async () => {
    prisma.userSubscription.findFirst.mockResolvedValueOnce(null);
    const result = await assignTagsAction({ subscriptionId: "sub-other", tagIds: ["t1"] });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(prisma.subscriptionTag.deleteMany).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when any tag belongs to another user or does not exist", async () => {
    prisma.userSubscription.findFirst.mockResolvedValueOnce({ id: "sub1" });
    prisma.tag.findMany.mockResolvedValueOnce([{ id: "t1", name: "Mine", slug: "mine", colorHex: "#EF4444" }]);

    const result = await assignTagsAction({ subscriptionId: "sub1", tagIds: ["t1", "t-other"] });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(prisma.subscriptionTag.deleteMany).not.toHaveBeenCalled();
  });

  it("deduplicates tagIds and sorts returned tags", async () => {
    prisma.userSubscription.findFirst.mockResolvedValueOnce({ id: "sub1" });
    prisma.tag.findMany.mockResolvedValueOnce([
      { id: "t2", name: "Zeta", slug: "zeta", colorHex: "#3B82F6" },
      { id: "t1", name: "Alpha", slug: "alpha", colorHex: "#EF4444" },
    ]);

    const result = await assignTagsAction({ subscriptionId: "sub1", tagIds: ["t2", "t1", "t2"] });
    expect(result).toEqual({
      ok: true,
      data: {
        subscriptionId: "sub1",
        tags: [
          { id: "t1", name: "Alpha", slug: "alpha", colorHex: "#EF4444" },
          { id: "t2", name: "Zeta", slug: "zeta", colorHex: "#3B82F6" },
        ],
      },
    });
    expect(prisma.subscriptionTag.createMany).toHaveBeenCalledWith({
      data: [
        { subscriptionId: "sub1", tagId: "t2" },
        { subscriptionId: "sub1", tagId: "t1" },
      ],
      skipDuplicates: true,
    });
  });

  it("clears tags when tagIds is empty", async () => {
    prisma.userSubscription.findFirst.mockResolvedValueOnce({ id: "sub1" });
    prisma.tag.findMany.mockResolvedValueOnce([]);

    const result = await assignTagsAction({ subscriptionId: "sub1", tagIds: [] });
    expect(result).toEqual({ ok: true, data: { subscriptionId: "sub1", tags: [] } });
    expect(prisma.subscriptionTag.deleteMany).toHaveBeenCalledWith({ where: { subscriptionId: "sub1" } });
    expect(prisma.subscriptionTag.createMany).not.toHaveBeenCalled();
  });
});
