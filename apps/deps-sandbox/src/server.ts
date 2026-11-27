/**
 * `deps-sandbox` entry point (Slice 08 §3.10): runs package managers on untrusted manifests with no secrets.
 * Refuses to start without `DEPS_SANDBOX_TOKEN`. Handles SIGTERM / SIGINT gracefully: stops accepting requests,
 * aborts the running job (the caller gets BUSY and retries) and removes its temp dir.
 */
import { createSandboxServer, loadConfig } from "./app.js";
import { log } from "./logger.js";
import { detectToolVersions } from "./tools.js";

const SHUTDOWN_GRACE_MS = 20_000;

let closeSandbox: (() => Promise<void>) | undefined;
let stopping = false;

function shutdown(reason: string, exitCode = 0): void {
  if (stopping) return;
  stopping = true;
  log.info({ reason }, `${reason} received, shutting down`);
  const force = setTimeout(() => {
    log.error("shutdown timed out, exiting");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  force.unref();
  (closeSandbox ? closeSandbox() : Promise.resolve()).then(
    () => {
      clearTimeout(force);
      process.exit(exitCode);
    },
    (err: unknown) => {
      clearTimeout(force);
      log.error("shutdown error", err);
      process.exit(1);
    },
  );
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", reason);
  shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err);
  // State may be corrupt after an uncaught exception: exit immediately
  // rather than attempting a graceful shutdown.
  process.exit(1);
});

async function main(): Promise<void> {
  const config = loadConfig();
  const host = process.env.HOST?.trim() || undefined;
  // The token stays in memory only; children get an environment built from scratch anyway.
  delete process.env.DEPS_SANDBOX_TOKEN;

  const tools = await detectToolVersions();
  const { server, close } = createSandboxServer({ config, tools });
  closeSandbox = close;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const onListen = () => {
      server.off("error", reject);
      resolve();
    };
    if (host) server.listen(config.port, host, onListen);
    else server.listen(config.port, onListen);
  });
  const toolList = Object.entries(tools)
    .map(([name, version]) => `${name} ${version}`)
    .join(", ");
  log.info(
    { host: host ?? null, port: config.port, tools, proxy: Boolean(config.proxy) },
    `listening on ${host ?? ""}:${config.port} (${toolList}; proxy ${config.proxy ? "on" : "off"})`,
  );
}

main().catch((err: unknown) => {
  log.error("failed to start", err);
  process.exit(1);
});
