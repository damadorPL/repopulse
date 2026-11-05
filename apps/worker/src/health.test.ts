import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, errorMessage } from "./logger";
import { closeQueues, pollIntervalCron, registerSchedule, type Queues } from "./queues";

const queryRaw = vi.fn(async () => [{ "?column?": 1 }]);

vi.mock("@repopulse/db", () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
  },
}));

const { checkDatabase, checkRedis, getHealthReport, pingRedis, resolveHealthPort, startHealthServer } = await import(
  "./health"
);

describe("resolveHealthPort", () => {
  const original = process.env.HEALTH_PORT;
  afterEach(() => {
    if (original === undefined) delete process.env.HEALTH_PORT;
    else process.env.HEALTH_PORT = original;
  });

  it("defaults to 3001 when HEALTH_PORT is unset or empty", () => {
    delete process.env.HEALTH_PORT;
    expect(resolveHealthPort()).toBe(3001);
    process.env.HEALTH_PORT = "";
    expect(resolveHealthPort()).toBe(3001);
  });

  it("accepts valid ports in [0, 65535]", () => {
    process.env.HEALTH_PORT = "0";
    expect(resolveHealthPort()).toBe(0);
    process.env.HEALTH_PORT = "65535";
    expect(resolveHealthPort()).toBe(65535);
    process.env.HEALTH_PORT = "8080";
    expect(resolveHealthPort()).toBe(8080);
  });

  it.each(["-1", "65536", "abc", "3001.5"])("throws on invalid HEALTH_PORT %s", (val) => {
    process.env.HEALTH_PORT = val;
    expect(() => resolveHealthPort()).toThrow(/Invalid HEALTH_PORT/);
  });
});

describe("checkDatabase, checkRedis, pingRedis, and getHealthReport", () => {
  const originalRedisUrl = process.env.REDIS_URL;
  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    queryRaw.mockReset();
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  });

  it("checkDatabase returns ok when query succeeds and error when it rejects", async () => {
    expect(await checkDatabase()).toBe("ok");
    queryRaw.mockRejectedValueOnce(new Error("connection\nrefused"));
    expect(await checkDatabase()).toBe("error");
  });

  it("checkRedis returns skipped when REDIS_URL is unset and error on invalid URL", async () => {
    delete process.env.REDIS_URL;
    expect(await checkRedis()).toBe("skipped");

    process.env.REDIS_URL = "not-a-url";
    expect(await checkRedis()).toBe("error");
  });

  it("pingRedis validates URL protocol and speaks RESP over TCP", async () => {
    await expect(pingRedis("not-a-url")).rejects.toThrow("REDIS_URL is not a valid URL");
    await expect(pingRedis("http://localhost:6379")).rejects.toThrow('unsupported REDIS_URL protocol "http:"');

    const received: string[] = [];
    let responder: (data: string, socket: net.Socket) => void = (_data, socket) => {
      socket.write("+PONG\r\n");
    };

    const tcpServer = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        received.push(text);
        responder(text, socket);
      });
    });

    await new Promise<void>((resolve) => tcpServer.listen(0, "127.0.0.1", () => resolve()));
    const port = (tcpServer.address() as net.AddressInfo).port;

    try {
      await expect(pingRedis(`redis://127.0.0.1:${port}`)).resolves.toBeUndefined();
      expect(received.at(-1)).toContain("PING");

      responder = (_data, socket) => {
        socket.write("+OK\r\n+PONG\r\n");
      };
      await expect(pingRedis(`redis://default:secret@127.0.0.1:${port}`)).resolves.toBeUndefined();
      expect(received.at(-1)).toContain("AUTH");

      responder = (_data, socket) => {
        socket.write("-ERR invalid password\r\n+PONG\r\n");
      };
      await expect(pingRedis(`redis://:bad@127.0.0.1:${port}`)).rejects.toThrow("redis AUTH failed");

      responder = (_data, socket) => {
        socket.write("-LOADING\r\n");
      };
      await expect(pingRedis(`redis://127.0.0.1:${port}`)).rejects.toThrow("unexpected redis PING reply");
    } finally {
      await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    }
  });

  it("getHealthReport combines database and redis checks", async () => {
    delete process.env.REDIS_URL;
    const healthy = await getHealthReport();
    expect(healthy).toMatchObject({ status: "ok", checks: { database: "ok", redis: "skipped" } });

    queryRaw.mockRejectedValueOnce(new Error("db down"));
    const unhealthy = await getHealthReport();
    expect(unhealthy).toMatchObject({ status: "error", checks: { database: "error", redis: "skipped" } });
  });
});

describe("startHealthServer", () => {
  const originalRedisUrl = process.env.REDIS_URL;
  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    queryRaw.mockReset();
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  });

  it("serves 200 on healthy GET /health, 503 when unhealthy, and 404 on other routes or methods", async () => {
    delete process.env.REDIS_URL;
    const health = await startHealthServer(0);
    const baseUrl = `http://127.0.0.1:${health.port}`;

    try {
      const okRes = await fetch(`${baseUrl}/health?probe=1`);
      expect(okRes.status).toBe(200);
      expect(await okRes.json()).toMatchObject({ status: "ok", checks: { database: "ok", redis: "skipped" } });

      queryRaw.mockRejectedValueOnce(new Error("db down"));
      const errRes = await fetch(`${baseUrl}/health`);
      expect(errRes.status).toBe(503);
      expect(await errRes.json()).toMatchObject({ status: "error", checks: { database: "error", redis: "skipped" } });

      const notFoundRes = await fetch(`${baseUrl}/other`);
      expect(notFoundRes.status).toBe(404);
      expect(await notFoundRes.json()).toEqual({ status: "not_found" });

      const postRes = await fetch(`${baseUrl}/health`, { method: "POST" });
      expect(postRes.status).toBe(404);
    } finally {
      await health.close();
      // Calling close() a second time when already stopped resolves cleanly.
      await health.close();
    }
  });
});

describe("createLogger and errorMessage", () => {
  it("formats scope-prefixed messages and error stacks or values", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const log = createLogger("test-scope");
      log.info("started");
      log.warn("careful");
      log.error("failed without err");
      log.error("failed with string", "boom");

      expect(logSpy).toHaveBeenCalledWith("[test-scope] started");
      expect(warnSpy).toHaveBeenCalledWith("[test-scope] careful");
      expect(errSpy).toHaveBeenCalledWith("[test-scope] failed without err");
      expect(errSpy).toHaveBeenCalledWith("[test-scope] failed with string: boom");

      const errNoStack = new Error("plain message");
      errNoStack.stack = undefined;
      expect(errorMessage(errNoStack)).toBe("plain message");
      expect(errorMessage(42)).toBe("42");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe("queues helpers", () => {
  const originalCron = process.env.POLL_INTERVAL_CRON;
  afterEach(() => {
    if (originalCron === undefined) delete process.env.POLL_INTERVAL_CRON;
    else process.env.POLL_INTERVAL_CRON = originalCron;
  });

  it("pollIntervalCron returns trimmed env value or default cron", () => {
    delete process.env.POLL_INTERVAL_CRON;
    expect(pollIntervalCron()).toBe("*/30 * * * *");

    process.env.POLL_INTERVAL_CRON = "   ";
    expect(pollIntervalCron()).toBe("*/30 * * * *");

    process.env.POLL_INTERVAL_CRON = " */15 * * * * ";
    expect(pollIntervalCron()).toBe("*/15 * * * *");
  });

  it("registerSchedule upserts the repeatable schedule and enqueues an immediate scan", async () => {
    const schedulerQueue = {
      upsertJobScheduler: vi.fn(async () => undefined),
      add: vi.fn(async () => undefined),
    };
    await registerSchedule(schedulerQueue as never, "*/10 * * * *");
    expect(schedulerQueue.upsertJobScheduler).toHaveBeenCalledWith(
      "repo-scheduler-cron",
      { pattern: "*/10 * * * *" },
      { name: "scan-due-repositories", data: {} },
    );
    expect(schedulerQueue.add).toHaveBeenCalledWith("scan-due-repositories", {});
  });

  it("closeQueues closes all four queues", async () => {
    const q = () => ({ close: vi.fn(async () => undefined) });
    const queues = {
      schedulerQueue: q(),
      repoPollQueue: q(),
      notificationQueue: q(),
      releaseBackfillQueue: q(),
    } as unknown as Queues;
    await closeQueues(queues);
    expect(queues.schedulerQueue.close).toHaveBeenCalledTimes(1);
    expect(queues.repoPollQueue.close).toHaveBeenCalledTimes(1);
    expect(queues.notificationQueue.close).toHaveBeenCalledTimes(1);
    expect(queues.releaseBackfillQueue.close).toHaveBeenCalledTimes(1);
  });
});
