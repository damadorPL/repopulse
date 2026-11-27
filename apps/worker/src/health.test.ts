import { PassThrough } from "node:stream";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkDatabase,
  checkRedis,
  getHealthReport,
  pingRedis,
  resolveHealthPort,
  startHealthServer,
} from "./health.js";
import { createLogger, errorMessage } from "./logger.js";
import { closeQueues, pollIntervalCron, registerSchedule, type Queues } from "./queues/index.js";

const { queryRaw } = vi.hoisted(() => ({
  queryRaw: vi.fn(async (..._args: unknown[]) => [{ "?column?": 1 }]),
}));

vi.mock("@repopulse/db", () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
  },
}));

describe("resolveHealthPort", () => {
  it("defaults to 3001 when HEALTH_PORT is unset or empty", () => {
    vi.stubEnv("HEALTH_PORT", undefined);
    expect(resolveHealthPort()).toBe(3001);
    vi.stubEnv("HEALTH_PORT", "");
    expect(resolveHealthPort()).toBe(3001);
  });

  it("accepts valid ports in [0, 65535]", () => {
    vi.stubEnv("HEALTH_PORT", "0");
    expect(resolveHealthPort()).toBe(0);
    vi.stubEnv("HEALTH_PORT", "65535");
    expect(resolveHealthPort()).toBe(65535);
    vi.stubEnv("HEALTH_PORT", "8080");
    expect(resolveHealthPort()).toBe(8080);
  });

  it.each(["-1", "65536", "abc", "3001.5"])("throws on invalid HEALTH_PORT %s", (val) => {
    vi.stubEnv("HEALTH_PORT", val);
    expect(() => resolveHealthPort()).toThrow(/Invalid HEALTH_PORT/);
  });
});

describe("checkDatabase, checkRedis, pingRedis, and getHealthReport", () => {
  afterEach(() => {
    queryRaw.mockReset();
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  });

  it("checkDatabase returns ok when query succeeds and error when it rejects", async () => {
    expect(await checkDatabase()).toBe("ok");
    queryRaw.mockRejectedValueOnce(new Error("connection\nrefused"));
    expect(await checkDatabase()).toBe("error");
  });

  it("checkRedis returns skipped when REDIS_URL is unset and error on invalid URL", async () => {
    vi.stubEnv("REDIS_URL", undefined);
    expect(await checkRedis()).toBe("skipped");

    vi.stubEnv("REDIS_URL", "not-a-url");
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
    vi.stubEnv("REDIS_URL", undefined);
    const healthy = await getHealthReport();
    expect(healthy).toMatchObject({ status: "ok", checks: { database: "ok", redis: "skipped" } });

    queryRaw.mockRejectedValueOnce(new Error("db down"));
    const unhealthy = await getHealthReport();
    expect(unhealthy).toMatchObject({ status: "error", checks: { database: "error", redis: "skipped" } });
  });
});

describe("startHealthServer", () => {
  afterEach(() => {
    queryRaw.mockReset();
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  });

  it("serves 200 on healthy GET /health, 503 when unhealthy, and 404 on other routes or methods", async () => {
    vi.stubEnv("REDIS_URL", undefined);
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
  it("emits structured JSON logs with service context and formats error stacks or values", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    stream.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) lines.push(line);
      }
    });

    const log = createLogger("test-scope", { level: "info", destination: stream });
    log.info("started");
    log.info({ queue: "repo-poll", jobId: "j1", repositoryId: "r1" }, "polling");
    log.warn("careful");
    log.error("failed without err");
    log.error("failed with string", "boom");
    log.error("failed with error", new Error("kaboom"));

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toHaveLength(6);
    expect(parsed[0]).toMatchObject({ service: "test-scope", msg: "started", level: 30 });
    expect(typeof parsed[0]!.time).toBe("string");
    expect(parsed[1]).toMatchObject({
      service: "test-scope",
      queue: "repo-poll",
      jobId: "j1",
      repositoryId: "r1",
      msg: "polling",
    });
    expect(parsed[2]).toMatchObject({ service: "test-scope", msg: "careful", level: 40 });
    expect(parsed[3]).toMatchObject({ service: "test-scope", msg: "failed without err", level: 50 });
    expect(parsed[4]).toMatchObject({ service: "test-scope", msg: "failed with string", err: "boom", level: 50 });
    expect(parsed[5]).toMatchObject({
      service: "test-scope",
      msg: "failed with error",
      err: { message: "kaboom" },
      level: 50,
    });

    const errNoStack = new Error("plain message");
    errNoStack.stack = undefined;
    expect(errorMessage(errNoStack)).toBe("plain message");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("queues helpers", () => {
  it("pollIntervalCron returns trimmed env value or default cron", () => {
    vi.stubEnv("POLL_INTERVAL_CRON", undefined);
    expect(pollIntervalCron()).toBe("*/30 * * * *");

    vi.stubEnv("POLL_INTERVAL_CRON", "   ");
    expect(pollIntervalCron()).toBe("*/30 * * * *");

    vi.stubEnv("POLL_INTERVAL_CRON", " */15 * * * * ");
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
    expect(schedulerQueue.add).toHaveBeenCalledWith(
      "scan-due-repositories",
      {},
      { deduplication: { id: "repo-scheduler-cron-startup", keepLastIfActive: true } },
    );
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
