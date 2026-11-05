/** Registry/source policy shared by scans and update PR analysis. Never fetches repository-supplied URLs. */
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { DependencyEcosystem, ParsedDependency } from "./types.js";
import { basename, dirname, isRecord, joinPath, normalizePypiName } from "./util.js";

const NPM_CONFIGS = [".yarnrc", ".yarnrc.yml", "bunfig.toml", ".bunfig.toml", "pnpm-workspace.yaml", ".npmrc"];
const PYTHON_CONFIGS = ["pyproject.toml", "uv.toml", "poetry.toml", "pip.conf", "pip.ini"];
const PRIVATE_SOURCE_REASON = "Resolved from a custom registry or repository source";

function ancestors(path: string): string[] {
  const parts = dirname(path).split("/").filter(Boolean);
  return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

/** Existing files among these candidates must be read, including ancestor configs for nested manifests. */
export function registryConfigPaths(path: string, ecosystem: DependencyEcosystem): string[] {
  return ancestors(path).flatMap((dir) => (ecosystem === "NPM" ? NPM_CONFIGS : PYTHON_CONFIGS).map((file) => joinPath(dir, file)));
}

function publicRegistry(value: unknown, ecosystem: DependencyEcosystem): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value.trim().replace(/^["']|["']$/g, ""));
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) return false;
    const path = url.pathname.replace(/\/+$/, "");
    return ecosystem === "NPM"
      ? ["registry.npmjs.org", "registry.yarnpkg.com"].includes(url.hostname) && path === ""
      : ["pypi.org", "pypi.python.org"].includes(url.hostname) && path === "/simple";
  } catch {
    return false;
  }
}

interface RegistryPolicy {
  customDefault: boolean;
  /** Additional indexes cannot be made safe by resetting the default index. */
  additional: boolean;
  unreadable: boolean;
  scopes: Map<string, boolean>;
  packages: Set<string>;
}

function emptyPolicy(): RegistryPolicy {
  return { customDefault: false, additional: false, unreadable: false, scopes: new Map(), packages: new Set() };
}

function registrySettings(data: Record<string, unknown>, policy: RegistryPolicy): void {
  for (const key of ["registry", "npmRegistryServer"]) {
    if (key in data) policy.customDefault = !publicRegistry(data[key], "NPM");
  }
  for (const key of ["registries", "npmScopes", "scopes"]) {
    const scopes = data[key];
    if (scopes === undefined) continue;
    if (!isRecord(scopes)) { policy.unreadable = true; continue; }
    for (const [scope, setting] of Object.entries(scopes)) {
      const value = isRecord(setting) ? setting.npmRegistryServer ?? setting.registry ?? setting.url : setting;
      // An auth-only scope inherits the default registry.
      if (isRecord(setting) && value === undefined) continue;
      policy.scopes.set(scope.replace(/^@/, ""), !publicRegistry(value, "NPM"));
    }
  }
}

function npmConfig(path: string, text: string, policy: RegistryPolicy): void {
  const file = basename(path);
  if (!text.trim()) return;
  if (file === ".npmrc" || file === ".yarnrc") {
    for (const raw of text.split(/\r?\n/)) {
      if (/^\s*[#;]/.test(raw)) continue;
      const match = file === ".npmrc"
        ? /^\s*(?:(@[^:=\s]+):)?registry\s*=\s*(.*?)\s*$/.exec(raw)
        : /^\s*"?registry"?\s+(.*?)\s*$/.exec(raw);
      if (!match) continue;
      const value = match[file === ".npmrc" ? 2 : 1];
      const scope = file === ".npmrc" ? match[1] : undefined;
      if (scope) policy.scopes.set(scope.slice(1), !publicRegistry(value, "NPM"));
      else policy.customDefault = !publicRegistry(value, "NPM");
    }
    return;
  }
  const data: unknown = file.endsWith(".toml") ? parseToml(text) : parseYaml(text, { maxAliasCount: 50 });
  if (!isRecord(data)) { policy.unreadable = true; return; }
  registrySettings(data, policy);
  if (isRecord(data.install)) registrySettings(data.install, policy);
  // pnpm also permits quoted scoped registry keys.
  for (const [key, value] of Object.entries(data)) {
    const scope = /^@([^:]+):registry$/.exec(key)?.[1];
    if (scope) policy.scopes.set(scope, !publicRegistry(value, "NPM"));
  }
}

function pythonSettings(data: Record<string, unknown>, policy: RegistryPolicy): void {
  const defaultKeys = ["index-url", "index_url", "default-index", "index"] as const;
  let seenDefault = false;
  let anyCustomDefault = false;
  for (const key of defaultKeys) {
    const value = data[key];
    if (value === undefined || (key === "index" && (Array.isArray(value) || isRecord(value)))) continue;
    seenDefault = true;
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0 || values.some((entry) => !publicRegistry(entry, "PYPI"))) {
      anyCustomDefault = true;
    }
  }
  if (seenDefault) policy.customDefault = anyCustomDefault;
  for (const key of ["extra-index-url", "extra_index_url", "find-links", "find_links"]) {
    const value = data[key];
    if (value !== undefined) {
      const values = Array.isArray(value) ? value : [value];
      if (values.some((entry) => !publicRegistry(entry, "PYPI"))) policy.additional = true;
    }
  }
  const indexes = Array.isArray(data.index) ? data.index : isRecord(data.index) ? [data.index] : [];
  const named = new Map<string, boolean>();
  for (const index of indexes) {
    if (!isRecord(index)) { policy.unreadable = true; continue; }
    const custom = !publicRegistry(index.url, "PYPI");
    if (typeof index.name === "string") named.set(index.name, custom);
    if (custom && index.explicit !== true) policy.additional = true;
  }
  if (isRecord(data.sources)) {
    for (const [name, entries] of Object.entries(data.sources)) {
      const sources = Array.isArray(entries) ? entries : [entries];
      if (sources.some((source) => !isRecord(source) || typeof source.index !== "string" || named.get(source.index) !== false)) {
        policy.packages.add(normalizePypiName(name));
      }
    }
  }
}

function pythonConfig(path: string, text: string, policy: RegistryPolicy): void {
  const file = basename(path);
  if (file === "pip.conf" || file === "pip.ini") {
    let section = "global";
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*[#;]/.test(line)) continue;
      const header = /^\s*\[([^\]]+)\]/.exec(line);
      if (header) { section = header[1]!.toLowerCase(); continue; }
      const match = /^\s*(index-url|extra-index-url|find-links)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && ["global", "install", "download"].includes(section)) pythonSettings({ [match[1]!]: match[2] }, policy);
    }
    return;
  }
  const data = parseToml(text);
  pythonSettings(data, policy);
  if (isRecord(data.pip)) {
    const pipPolicy = emptyPolicy();
    pythonSettings(data.pip, pipPolicy);
    if (pipPolicy.customDefault) policy.customDefault = true;
    if (pipPolicy.additional) policy.additional = true;
    if (pipPolicy.unreadable) policy.unreadable = true;
    for (const pkg of pipPolicy.packages) policy.packages.add(pkg);
  }
  if (isRecord(data.repositories) && Object.keys(data.repositories).length) policy.additional = true;
  const tool = isRecord(data.tool) ? data.tool : null;
  if (tool && isRecord(tool.uv)) {
    pythonSettings(tool.uv, policy);
    if (isRecord(tool.uv.pip)) {
      const pipPolicy = emptyPolicy();
      pythonSettings(tool.uv.pip, pipPolicy);
      if (pipPolicy.customDefault) policy.customDefault = true;
      if (pipPolicy.additional) policy.additional = true;
      if (pipPolicy.unreadable) policy.unreadable = true;
      for (const pkg of pipPolicy.packages) policy.packages.add(pkg);
    }
  }
  const poetry = tool && isRecord(tool.poetry) ? tool.poetry : null;
  if (poetry && Array.isArray(poetry.source)) {
    for (const source of poetry.source) {
      if (!isRecord(source) || (!publicRegistry(source.url, "PYPI") && source.priority !== "explicit")) policy.additional = true;
    }
  }
}

function policyFamily(ecosystem: DependencyEcosystem, file: string): string {
  if (ecosystem === "NPM") return file === ".bunfig.toml" ? "bunfig.toml" : file;
  if (file === "pip.conf" || file === "pip.ini") return "pip";
  if (file === "pyproject.toml" || file === "uv.toml") return "uv";
  return file;
}

/** Missing text for an existing config fails closed; reasons never expose URLs or credentials. */
export function applyRegistryPolicy<T extends ParsedDependency>(params: {
  path: string;
  ecosystem: DependencyEcosystem;
  dependencies: readonly T[];
  files: ReadonlyMap<string, string | null>;
}): T[] {
  // Different package managers can read different configuration formats. A public .npmrc must not clear
  // a private Yarn/Bun setting, and a public pip.conf must not clear a private pyproject.toml/uv.toml setting.
  // Resolve ancestor overrides within each format family, then combine conservatively.
  const policies = new Map<string, RegistryPolicy>();
  for (const path of registryConfigPaths(params.path, params.ecosystem)) {
    if (!params.files.has(path)) continue;
    const file = basename(path);
    const family = policyFamily(params.ecosystem, file);
    let policy = policies.get(family);
    if (!policy) { policy = emptyPolicy(); policies.set(family, policy); }
    const text = params.files.get(path);
    if (text == null) { policy.unreadable = true; continue; }
    try {
      if (params.ecosystem === "NPM") npmConfig(path, text, policy);
      else pythonConfig(path, text, policy);
    } catch {
      policy.unreadable = true;
    }
  }
  return params.dependencies.map((dependency) => {
    const scope = /^@([^/]+)\//.exec(dependency.name)?.[1];
    const unsupported = [...policies.values()].some((policy) => {
      const custom = params.ecosystem === "NPM" && scope && policy.scopes.has(scope)
        ? policy.scopes.get(scope)!
        : policy.customDefault;
      return custom || policy.additional || policy.unreadable || policy.packages.has(normalizePypiName(dependency.name));
    });
    return dependency.supported && unsupported
      ? { ...dependency, supported: false, unsupportedReason: PRIVATE_SOURCE_REASON }
      : dependency;
  });
}
