import { defineConfig } from "knip/config";

export default defineConfig((options) => {
  const isStrict = Boolean(options.strict);

  return {
    treatConfigHintsAsErrors: true,
    treatTagHintsAsErrors: true,
    includeSubpathExports: true,
    ignoreExportsUsedInFile: isStrict ? true : { interface: true, type: true },
    include: ["nsExports", "nsTypes"],
    ...(isStrict ? { tags: ["-internal"] } : {}),
    workspaces: {
      ".": {
        entry: ["scripts/install-hooks.ts!", "scripts/pre-commit-lint.ts!", "scripts/commit-msg-lint.ts!"],
        project: ["scripts/**/*.{mjs,ts}"],
      },
      "apps/web": {
        ignoreDependencies: isStrict
          ? ["bullmq", "ioredis", "tailwindcss", "tw-animate-css", "@tailwindcss/typography"]
          : ["bullmq", "ioredis"],
      },
      "apps/worker": {},
      "apps/deps-worker": {
        project: ["src/**/*.ts!", "!src/testing/**/*.ts!", "src/testing/**/*.ts"],
      },
      "apps/deps-sandbox": isStrict ? { ignoreDependencies: ["pino-pretty"] } : {},
      "packages/db": {
        entry: ["src/bootstrap-app-role.ts!"],
        includeEntryExports: !isStrict,
        ignoreDependencies: isStrict ? ["@prisma/client", "prisma"] : ["@prisma/client"],
      },
      "packages/deps": {
        includeEntryExports: !isStrict,
        project: ["src/**/*.ts!", "!**/*.test-data.ts!", "**/*.test-data.ts"],
      },
      "packages/github": {
        includeEntryExports: !isStrict,
      },
      "packages/notifications": {
        includeEntryExports: !isStrict,
      },
      "packages/queue": {
        includeEntryExports: !isStrict,
        ...(isStrict ? { ignoreDependencies: ["pino-pretty"] } : {}),
      },
    },
  };
});
