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
  const originalPoolMax = process.env.DATABASE_POOL_MAX;
  const originalAppName = process.env.DATABASE_APP_NAME;
  const originalPgAppName = process.env.PGAPPNAME;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPrisma = globalForPrisma.prisma;

  beforeEach(() => {
    vi.resetModules();
    hoisted.PrismaPgMock.mockClear();
    hoisted.PrismaClientMock.mockClear();
    delete globalForPrisma.prisma;
    delete process.env.DATABASE_POOL_MAX;
    delete process.env.DATABASE_APP_NAME;
    delete process.env.PGAPPNAME;
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/repopulse";
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPoolMax === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = originalPoolMax;
    if (originalAppName === undefined) delete process.env.DATABASE_APP_NAME;
    else process.env.DATABASE_APP_NAME = originalAppName;
    if (originalPgAppName === undefined) delete process.env.PGAPPNAME;
    else process.env.PGAPPNAME = originalPgAppName;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    if (originalPrisma === undefined) delete globalForPrisma.prisma;
    else globalForPrisma.prisma = originalPrisma;
    vi.restoreAllMocks();
  });

  it("configures PrismaPg pool defaults, error hooks, and Prisma global omit for encrypted columns", async () => {
    const mod = await import("./index.js");

    expect(hoisted.PrismaPgMock).toHaveBeenCalledTimes(1);
    const [poolConfig, pgOptions] = hoisted.PrismaPgMock.mock.calls[0] as [
      {
        connectionString?: string;
        max?: number;
        idleTimeoutMillis?: number;
        connectionTimeoutMillis?: number;
        query_timeout?: number;
        application_name?: string;
      },
      {
        onPoolError?: (err: Error) => void;
        onConnectionError?: (err: Error) => void;
        statementNameGenerator?: unknown;
      },
    ];
    expect(poolConfig).toEqual({
      connectionString: "postgresql://user:pass@localhost:5432/repopulse",
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      query_timeout: 35_000,
      application_name: "repopulse",
    });
    expect(pgOptions.statementNameGenerator).toBeUndefined();
    expect(typeof pgOptions.onPoolError).toBe("function");
    expect(typeof pgOptions.onConnectionError).toBe("function");
    expect(globalForPrisma.prisma).toBe(mod.prisma);

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

  it("respects valid DATABASE_POOL_MAX, DATABASE_APP_NAME, and PGAPPNAME fallback", async () => {
    process.env.DATABASE_POOL_MAX = "25";
    process.env.DATABASE_APP_NAME = "repopulse-worker";
    process.env.PGAPPNAME = "ignored-fallback";

    await import("./index.js");

    const [poolConfig] = hoisted.PrismaPgMock.mock.calls[0] as [{ max?: number; application_name?: string }, unknown];
    expect(poolConfig.max).toBe(25);
    expect(poolConfig.application_name).toBe("repopulse-worker");

    vi.resetModules();
    hoisted.PrismaPgMock.mockClear();
    delete globalForPrisma.prisma;
    delete process.env.DATABASE_APP_NAME;
    process.env.PGAPPNAME = "repopulse-deps";

    await import("./index.js");
    const [fallbackConfig] = hoisted.PrismaPgMock.mock.calls[0] as [{ application_name?: string }, unknown];
    expect(fallbackConfig.application_name).toBe("repopulse-deps");
  });

  it("falls back to max=10 for invalid DATABASE_POOL_MAX values", async () => {
    const { parsePoolMax } = await import("./index.js");
    expect(parsePoolMax(undefined)).toBe(10);
    expect(parsePoolMax("")).toBe(10);
    expect(parsePoolMax("0")).toBe(10);
    expect(parsePoolMax("101")).toBe(10);
    expect(parsePoolMax("-5")).toBe(10);
    expect(parsePoolMax("12.5")).toBe(10);
    expect(parsePoolMax("abc")).toBe(10);
    expect(parsePoolMax("1")).toBe(1);
    expect(parsePoolMax("100")).toBe(100);
    expect(parsePoolMax(" 16 ")).toBe(16);
  });

  it("caches prisma unconditionally on globalThis even in production", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const mod1 = await import("./index.js");
    expect(globalForPrisma.prisma).toBe(mod1.prisma);

    vi.resetModules();
    hoisted.PrismaClientMock.mockClear();
    const mod2 = await import("./index.js");
    expect(mod2.prisma).toBe(mod1.prisma);
    expect(hoisted.PrismaClientMock).not.toHaveBeenCalled();
  });
});
