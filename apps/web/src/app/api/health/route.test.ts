import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = {
  $queryRaw: vi.fn(),
};

vi.mock("@repopulse/db", () => ({ prisma }));

const { GET } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/health", () => {
  it("returns 200 ok when the database query succeeds", async () => {
    prisma.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      timestamp: expect.any(String),
    });
  });

  it("returns 503 when the database query fails", async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error("Connection refused"));
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "error",
      message: "database unavailable",
      timestamp: expect.any(String),
    });
  });
});
