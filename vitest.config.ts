import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["apps/*/vitest.config.ts", "packages/*/vitest.config.ts", "scripts/vitest.config.ts"],
    unstubEnvs: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
});
