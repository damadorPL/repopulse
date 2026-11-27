import type { KnipConfig } from "knip";

const isStrictDependencies = process.argv.includes("--strict");

const config: KnipConfig = {
  treatConfigHintsAsErrors: true,
  ignoreExportsUsedInFile: true,
  include: ["nsExports", "nsTypes"],
  workspaces: {
    ".": {
      entry: ["scripts/install-hooks.ts!"],
      project: ["scripts/**/*.{mjs,ts}"],
    },
    "apps/web": {
      project: ["src/**/*.{ts,tsx,css}!"],
      ignoreDependencies: isStrictDependencies
        ? ["bullmq", "ioredis", "tailwindcss", "tw-animate-css", "@tailwindcss/typography"]
        : ["bullmq", "ioredis"],
    },
    "apps/worker": {
      project: ["src/**/*.ts!"],
    },
    "apps/deps-worker": {
      project: ["src/**/*.ts!"],
    },
    "apps/deps-sandbox": {
      project: ["src/**/*.ts!"],
      ...(isStrictDependencies ? { ignoreDependencies: ["pino-pretty"] } : {}),
    },
    "packages/db": {
      entry: ["src/bootstrap-app-role.ts!"],
      ignoreDependencies: isStrictDependencies ? ["@prisma/client", "prisma"] : ["@prisma/client"],
    },
    "packages/deps": {
      project: ["src/**/*.ts!"],
    },
    "packages/github": {
      project: ["src/**/*.ts!"],
    },
    "packages/notifications": {
      project: ["src/**/*.ts!"],
    },
    "packages/queue": {
      project: ["src/**/*.ts!"],
      ...(isStrictDependencies ? { ignoreDependencies: ["pino-pretty"] } : {}),
    },
  },
};

export default config;
