/**
 * `deps-sandbox` entry point (Slice 08 §3.10): runs package managers on untrusted manifests with no secrets.
 * Refuses to start without `DEPS_SANDBOX_TOKEN`. Handles SIGTERM / SIGINT gracefully: stops accepting requests,
 * aborts the running job (the caller gets BUSY and retries) and removes its temp dir.
 */
import { createSandboxServer, loadConfig } from "./app.js";
import { detectToolVersions } from "./tools.js";

const SHUTDOWN_GRACE_MS = 20_000;

async function main(): Promise<void> {
  const config = loadConfig();
  // The token stays in memory only; children get an environment built from scratch anyway.
  delete process.env.DEPS_SANDBOX_TOKEN;

  const tools = await detectToolVersions();
  const { server, close } = createSandboxServer({ config, tools });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const toolList = Object.entries(tools)
    .map(([name, version]) => `${name} ${version}`)
    .join(", ");
  console.log(`[deps-sandbox] listening on :${config.port} (${toolList}; proxy ${config.proxy ? "on" : "off"})`);

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`[deps-sandbox] ${signal} received, shutting down`);
    const force = setTimeout(() => {
      console.error("[deps-sandbox] shutdown timed out, exiting");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(`[deps-sandbox] shutdown error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(`[deps-sandbox] failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
