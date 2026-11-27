import net from "node:net";

import { prisma } from "@repopulse/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pingRedis, resolveHealthPort, startHealthServer, type HealthServer } from "./health.js";

let activeServer: HealthServer | null = null;

afterEach(async () => {
  await activeServer?.close();
  activeServer = null;
});

describe("resolveHealthPort", () => {
  it("defaults to 3002 and validates DEPS_HEALTH_PORT", () => {
    vi.stubEnv("DEPS_HEALTH_PORT", undefined);
    expect(resolveHealthPort()).toBe(3002);
    vi.stubEnv("DEPS_HEALTH_PORT", "4050");
    expect(resolveHealthPort()).toBe(4050);
    for (const bad of ["-1", "65536", "abc"]) {
      vi.stubEnv("DEPS_HEALTH_PORT", bad);
      expect(() => resolveHealthPort()).toThrow(/Invalid DEPS_HEALTH_PORT/);
    }
  });
});

describe("pingRedis", () => {
  it("rejects invalid URLs and unsupported protocols", async () => {
    await expect(pingRedis("not-a-url")).rejects.toThrow(/not a valid URL/);
    await expect(pingRedis("http://localhost:6379")).rejects.toThrow(/unsupported REDIS_URL protocol/);
  });

  it("sends AUTH (when password is set) and PING over a raw TCP socket", async () => {
    const received: string[] = [];
    let authOk = true;
    let pingReply = "+PONG\r\n";
    const tcp = net.createServer((socket) => {
      socket.on("data", (data) => {
        const str = data.toString("utf8");
        received.push(str);
        if (str.includes("AUTH")) {
          if (!authOk) {
            socket.write("-ERR invalid password\r\n-NOAUTH Authentication required.\r\n");
            return;
          }
          socket.write(`+OK\r\n${pingReply}`);
        } else {
          socket.write(pingReply);
        }
      });
    });
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const { port } = tcp.address() as net.AddressInfo;

    try {
      await expect(pingRedis(`redis://127.0.0.1:${port}`)).resolves.toBeUndefined();
      expect(received[0]).toContain("*1\r\n$4\r\nPING\r\n");

      await expect(pingRedis(`redis://default:s3cr3t@127.0.0.1:${port}`)).resolves.toBeUndefined();
      expect(received[1]).toContain("AUTH");
      expect(received[1]).toContain("s3cr3t");

      authOk = false;
      await expect(pingRedis(`redis://:badpass@127.0.0.1:${port}`)).rejects.toThrow(/redis AUTH failed/);

      authOk = true;
      pingReply = "-LOADING\r\n";
      await expect(pingRedis(`redis://127.0.0.1:${port}`)).rejects.toThrow(/unexpected redis PING reply/);
    } finally {
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
    }
  });
});

describe("startHealthServer", () => {
  it("serves 200 on GET /health when healthy, 503 when database fails, and 404 on other routes", async () => {
    const errSpy = vi.spyOn(console, "error").mockReturnValue(undefined);
    vi.stubEnv("REDIS_URL", undefined);
    const querySpy = vi.spyOn(prisma, "$queryRaw").mockResolvedValue([1] as never);

    activeServer = await startHealthServer(0);
    const base = `http://127.0.0.1:${activeServer.port}`;

    const okRes = await fetch(`${base}/health`);
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toMatchObject({
      status: "ok",
      checks: { database: "ok", redis: "skipped" },
    });

    const notFound = await fetch(`${base}/other`);
    expect(notFound.status).toBe(404);

    querySpy.mockRejectedValueOnce(new Error("db connection refused"));
    const failRes = await fetch(`${base}/health`);
    expect(failRes.status).toBe(503);
    expect(await failRes.json()).toMatchObject({
      status: "error",
      checks: { database: "error", redis: "skipped" },
    });
    errSpy.mockRestore();
  });
});
