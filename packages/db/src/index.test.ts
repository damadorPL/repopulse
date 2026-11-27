import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const prismaInstance = { $connect: vi.fn(), $disconnect: vi.fn() };
  const PrismaPgMock = vi.fn(function (this: unknown, poolConfig: unknown, options: unknown) {
    return { poolConfig, options };
  });
  const PrismaClientMock = vi.fn(function (this: unknown, clientOptions: unknown) {
    return { ...prismaInstance, clientOptions };
  });
  return { PrismaPgMock, PrismaClientMock };
});

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: hoisted.PrismaPgMock,
}));

vi.mock("./generated/prisma/client.js", () => ({
  PrismaClient: hoisted.PrismaClientMock,
}));

describe("db client configuration", () => {
  const globalForPrisma = globalThis as unknown as { prisma?: unknown };
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPrisma = globalForPrisma.prisma;

  beforeEach(() => {
    vi.resetModules();
    hoisted.PrismaPgMock.mockClear();
    hoisted.PrismaClientMock.mockClear();
    delete globalForPrisma.prisma;
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/repopulse";
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPrisma === undefined) delete globalForPrisma.prisma;
    else globalForPrisma.prisma = originalPrisma;
    vi.restoreAllMocks();
  });

  it("configures PrismaPg pool timeouts, error hooks, and Prisma global omit for encrypted columns", async () => {
    await import("./index.js");

    expect(hoisted.PrismaPgMock).toHaveBeenCalledTimes(1);
    const [poolConfig, pgOptions] = hoisted.PrismaPgMock.mock.calls[0] as [
      { connectionString?: string; connectionTimeoutMillis?: number; application_name?: string },
      {
        onPoolError?: (err: Error) => void;
        onConnectionError?: (err: Error) => void;
        statementNameGenerator?: unknown;
      },
    ];
    expect(poolConfig).toEqual({
      connectionString: "postgresql://user:pass@localhost:5432/repopulse",
      connectionTimeoutMillis: 10_000,
      application_name: "repopulse",
    });
    expect(pgOptions.statementNameGenerator).toBeUndefined();
    expect(typeof pgOptions.onPoolError).toBe("function");
    expect(typeof pgOptions.onConnectionError).toBe("function");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const poolErr = new Error("pool boom");
    const connErr = new Error("conn boom");
    pgOptions.onPoolError!(poolErr);
    pgOptions.onConnectionError!(connErr);
    expect(errorSpy).toHaveBeenCalledWith("[db] idle pool client error", poolErr);
    expect(errorSpy).toHaveBeenCalledWith("[db] connection error", connErr);

    expect(hoisted.PrismaClientMock).toHaveBeenCalledTimes(1);
    const [clientOptions] = hoisted.PrismaClientMock.mock.calls[0] as [
      { omit?: Record<string, Record<string, boolean>> },
    ];
    expect(clientOptions.omit).toEqual({
      user: {
        githubAccessTokenEncrypted: true,
      },
      instanceSettings: {
        smtpPasswordEncrypted: true,
        githubAppPrivateKeyEncrypted: true,
        githubAppWebhookSecretEncrypted: true,
      },
    });
  });
});
