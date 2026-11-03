/**
 * In-memory stand-in for the Prisma calls the deps-worker makes (tests only; excluded from the build). Supports
 * the query shapes used here: equality, `in` / `notIn` / `not` / `lt` / `lte` / `gt` / `gte` / `has`, `AND` / `OR`,
 * compound unique keys (`projectId_path: { … }`), `{ increment }`, cursor pagination, `$transaction`. `select` is
 * ignored (whole rows are returned).
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const OPERATORS = new Set(["in", "notIn", "not", "lt", "lte", "gt", "gte", "has", "equals", "isEmpty"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number | string);
  const y = b instanceof Date ? b.getTime() : (b as number | string);
  return x < y ? -1 : x > y ? 1 : 0;
}

function matchValue(actual: unknown, condition: unknown): boolean {
  if (isPlainObject(condition) && Object.keys(condition).every((key) => OPERATORS.has(key))) {
    for (const [op, value] of Object.entries(condition)) {
      switch (op) {
        case "in":
          if (!(value as unknown[]).some((v) => eq(actual, v))) return false;
          break;
        case "notIn":
          if ((value as unknown[]).some((v) => eq(actual, v))) return false;
          break;
        case "not":
          if (isPlainObject(value) ? matchValue(actual, value) : eq(actual, value)) return false;
          break;
        case "equals":
          if (!eq(actual, value)) return false;
          break;
        case "lt":
          if (actual === null || actual === undefined || cmp(actual, value) >= 0) return false;
          break;
        case "lte":
          if (actual === null || actual === undefined || cmp(actual, value) > 0) return false;
          break;
        case "gt":
          if (actual === null || actual === undefined || cmp(actual, value) <= 0) return false;
          break;
        case "gte":
          if (actual === null || actual === undefined || cmp(actual, value) < 0) return false;
          break;
        case "has":
          if (!Array.isArray(actual) || !actual.includes(value)) return false;
          break;
        case "isEmpty":
          if ((Array.isArray(actual) && actual.length === 0) !== value) return false;
          break;
      }
    }
    return true;
  }
  if (condition === null) return actual === null || actual === undefined;
  return eq(actual, condition);
}

export function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === "AND") {
      if (!(condition as Where[]).every((w) => matches(row, w))) return false;
    } else if (key === "OR") {
      if (!(condition as Where[]).some((w) => matches(row, w))) return false;
    } else if (key.includes("_") && isPlainObject(condition) && !Object.keys(condition).some((k) => OPERATORS.has(k))) {
      if (!matches(row, condition)) return false;
    } else if (!matchValue(row[key], condition)) return false;
  }
  return true;
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && "increment" in value) row[key] = ((row[key] as number) ?? 0) + (value.increment as number);
    else if (isPlainObject(value) && "set" in value) row[key] = value.set;
    else row[key] = value;
  }
}

const clone = <T>(row: T): T => ({ ...(row as object) }) as T;

let counter = 0;

export class FakeTable {
  rows: Row[] = [];
  constructor(
    private readonly defaults: () => Row = () => ({}),
    private readonly touch = false,
  ) {}

  private create1(data: Row): Row {
    const row: Row = { id: `id${++counter}`, ...this.defaults(), ...(this.touch ? { createdAt: new Date(), updatedAt: new Date() } : {}) };
    applyData(row, data);
    this.rows.push(row);
    return row;
  }

  findUnique = async ({ where }: { where: Where }) => {
    const row = this.rows.find((r) => matches(r, where));
    return row ? clone(row) : null;
  };
  findFirst = async (args: { where?: Where } = {}) => {
    const row = this.rows.find((r) => matches(r, args.where));
    return row ? clone(row) : null;
  };
  findMany = async (args: { where?: Where; orderBy?: unknown; take?: number; cursor?: Where; skip?: number } = {}) => {
    let out = this.rows.filter((r) => matches(r, args.where));
    const orders = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
    for (const order of [...orders].reverse()) {
      const [field, direction] = Object.entries(order as Record<string, unknown>)[0]!;
      const dir = (isPlainObject(direction) ? direction.sort : direction) === "desc" ? -1 : 1;
      out = [...out].sort((a, b) => dir * cmp(a[field] ?? "", b[field] ?? ""));
    }
    if (args.cursor) {
      const index = out.findIndex((r) => matches(r, args.cursor));
      out = out.slice(index === -1 ? out.length : index);
    }
    if (args.skip) out = out.slice(args.skip);
    if (args.take !== undefined) out = out.slice(0, args.take);
    return out.map(clone);
  };
  count = async (args: { where?: Where } = {}) => this.rows.filter((r) => matches(r, args.where)).length;
  create = async ({ data }: { data: Row }) => clone(this.create1(data));
  createMany = async ({ data }: { data: Row[] }) => {
    for (const item of data) this.create1(item);
    return { count: data.length };
  };
  update = async ({ where, data }: { where: Where; data: Row }) => {
    const row = this.rows.find((r) => matches(r, where));
    if (!row) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
    applyData(row, data);
    if (this.touch) row.updatedAt = new Date();
    return clone(row);
  };
  updateMany = async ({ where, data }: { where?: Where; data: Row }) => {
    const hits = this.rows.filter((r) => matches(r, where));
    for (const row of hits) applyData(row, data);
    return { count: hits.length };
  };
  upsert = async ({ where, create, update }: { where: Where; create: Row; update: Row }) => {
    const row = this.rows.find((r) => matches(r, where));
    if (row) {
      applyData(row, update);
      return clone(row);
    }
    return clone(this.create1(create));
  };
  delete = async ({ where }: { where: Where }) => {
    const index = this.rows.findIndex((r) => matches(r, where));
    if (index === -1) throw new Error("Record to delete does not exist.");
    return clone(this.rows.splice(index, 1)[0]!);
  };
  deleteMany = async (args: { where?: Where } = {}) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, args.where));
    return { count: before - this.rows.length };
  };
}

export const PROJECT_DEFAULTS = {
  userId: "u1",
  githubRepoId: 42,
  owner: "acme",
  name: "widget",
  fullName: "acme/widget",
  defaultBranch: "main",
  isPrivate: false,
  repositoryId: null,
  updateMode: "NOTIFY",
  maxUpdateLevel: "MINOR",
  includePrereleases: false,
  minReleaseAgeDays: 3,
  groupMode: "SEPARATE_MAJORS",
  rangeStrategy: "BUMP",
  maxOpenPrs: 5,
  scanIntervalHours: 24,
  notificationLevel: "MINOR_AND_UP",
  ignoreRules: [],
  manifestPaths: [],
  commitPrefix: "chore(deps):",
  notifyOnFirstScan: false,
  lastScannedAt: null,
  lastScannedSha: null,
  nextScanAt: null,
  scanStatus: "IDLE",
  scanError: null,
  errorCount: 0,
};

export function createFakePrisma() {
  const tables = {
    instanceSettings: new FakeTable(),
    user: new FakeTable(() => ({ githubAccessTokenEncrypted: null, githubLogin: null, name: null })),
    notificationRule: new FakeTable(() => ({ tagId: null, destinationUrl: null, enabled: true, onlyMajorReleases: false, events: ["RELEASES"] })),
    dependencyProject: new FakeTable(() => ({ ...PROJECT_DEFAULTS, ignoreRules: [], manifestPaths: [] }), true),
    dependencyManifest: new FakeTable(() => ({ lockfilePath: null, workspaceRoot: null, dependencyCount: 0, warnings: [] })),
    dependencyUpdate: new FakeTable(() => ({
      group: "",
      currentVersion: null,
      wantedVersion: null,
      targetVersion: null,
      latestVersion: null,
      level: null,
      targetReleasedAt: null,
      sourceRepoUrl: null,
      firstSeenAt: new Date(),
      notifiedAt: null,
    })),
    dependencyPullRequest: new FakeTable(() => ({ state: "OPEN", openedAt: new Date(), closedAt: null, targets: [] })),
    dependencyPrOwner: new FakeTable(),
  };
  const prisma = {
    ...tables,
    $transaction: async (arg: unknown) => {
      if (typeof arg === "function") return (arg as (tx: unknown) => Promise<unknown>)(prisma);
      return Promise.all(arg as Promise<unknown>[]);
    },
  };
  return prisma;
}

export type FakePrisma = ReturnType<typeof createFakePrisma>;

/** Seeds the settings row (`depsEnabled`) plus one user and one project; returns their ids. */
export function seed(prisma: FakePrisma, options: { depsEnabled?: boolean; project?: Row; user?: Row } = {}) {
  prisma.instanceSettings.rows.push({ id: 1, depsEnabled: options.depsEnabled ?? true, smtpHost: null, smtpPort: 587, smtpSecure: null, smtpUser: null, smtpPasswordEncrypted: null, smtpFrom: null });
  prisma.user.rows.push({ id: "u1", email: "dev@example.com", githubId: "1001", githubLogin: "dev", githubAccessTokenEncrypted: null, name: "Dev", ...options.user });
  const project = { id: "p1", ...PROJECT_DEFAULTS, ignoreRules: [], manifestPaths: [], createdAt: new Date(), updatedAt: new Date(), ...options.project };
  prisma.dependencyProject.rows.push(project);
  return project;
}
