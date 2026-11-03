/**
 * `pyproject.toml` parser: PEP 621 `[project]` dependencies and extras, PEP 735 `[dependency-groups]`, uv
 * `dev-dependencies` and Poetry `[tool.poetry.*]` tables. Values come from `smol-toml`; spans from
 * {@link locateTomlStrings}.
 */
import { parse as parseToml } from "smol-toml";
import type { DependencyKind, ParsedDependency, RangeSyntax } from "../types.js";
import { isRecord, normalizePypiName } from "../util.js";
import { isValidPep440Constraint } from "../versions/pep440.js";
import { ManifestParseError } from "./errors.js";
import { parsePep508 } from "./pep508.js";
import { locateTomlStrings, tomlPathKey, type TomlLocatedString } from "./toml-locate.js";

export interface PyprojectDependency extends ParsedDependency {
  /** Key path of the TOML string that holds `declared` (for the structural re-parse check). */
  valuePath: Array<string | number>;
  /** Offsets of `declared` inside that string's decoded value (`0..length` for Poetry version strings). */
  valueOffset: { start: number; end: number };
  extras: string[];
  marker: string | null;
}

export interface PyprojectManifest {
  projectName: string | null;
  /** `[project] requires-python`, else the Poetry `python` constraint (Poetry syntax), else `null`. */
  requiresPython: string | null;
  requiresPythonSyntax: "pep440" | "poetry";
  hasToolPoetry: boolean;
  hasToolUv: boolean;
  /** `[tool.uv.workspace]` members / exclude globs, or `null`. */
  uvWorkspace: { members: string[]; exclude: string[] } | null;
  dependencies: PyprojectDependency[];
  warnings: string[];
}

/** Parses `pyproject.toml` text. Throws {@link ManifestParseError} on invalid TOML. */
export function parsePyproject(text: string, path = "pyproject.toml"): PyprojectManifest {
  let data: Record<string, unknown>;
  let located: Map<string, TomlLocatedString>;
  try {
    data = parseToml(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<string, unknown>;
  } catch (error) {
    throw new ManifestParseError(path, `invalid TOML (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
  }
  const warnings: string[] = [];
  try {
    located = locateTomlStrings(text);
  } catch {
    // Valid TOML our tokenizer does not follow: values are still reported, but nothing is rewritable.
    located = new Map();
    warnings.push(`${path}: layout not understood, dependencies are reported but cannot be updated`);
  }

  const dependencies: PyprojectDependency[] = [];
  const project = isRecord(data.project) ? data.project : null;
  const tool = isRecord(data.tool) ? data.tool : null;
  const poetry = tool && isRecord(tool.poetry) ? tool.poetry : null;
  const uv = tool && isRecord(tool.uv) ? tool.uv : null;

  const addPep508 = (value: unknown, valuePath: Array<string | number>, kind: DependencyKind, group: string): void => {
    if (typeof value !== "string") return;
    const requirement = parsePep508(value);
    if (!requirement) {
      warnings.push(`${path}: unrecognized requirement "${value}" skipped`);
      return;
    }
    const location = located.get(tomlPathKey(valuePath));
    const span =
      location?.plain === true
        ? { start: location.span.start + requirement.specStart, end: location.span.start + requirement.specEnd }
        : null;
    const base = {
      name: normalizePypiName(requirement.name),
      rawName: requirement.name,
      kind,
      group,
      declared: requirement.url ? `@ ${requirement.url}` : requirement.specifier,
      rangeSyntax: "pep440" as RangeSyntax,
      span: requirement.url ? null : span,
      file: path,
      valuePath,
      valueOffset: { start: requirement.specStart, end: requirement.specEnd },
      extras: requirement.extras,
      marker: requirement.marker,
    };
    if (requirement.url) dependencies.push({ ...base, supported: false, unsupportedReason: "Direct URL reference" });
    else if (!requirement.valid) dependencies.push({ ...base, supported: false, unsupportedReason: "Invalid version specifier" });
    else dependencies.push({ ...base, supported: true });
  };

  const addPep508List = (list: unknown, basePath: Array<string | number>, kind: DependencyKind, group: string): void => {
    if (!Array.isArray(list)) return;
    list.forEach((value, index) => addPep508(value, [...basePath, index], kind, group));
  };

  if (project) {
    addPep508List(project.dependencies, ["project", "dependencies"], "PROD", "");
    if (isRecord(project["optional-dependencies"])) {
      for (const [extra, list] of Object.entries(project["optional-dependencies"])) {
        addPep508List(list, ["project", "optional-dependencies", extra], "GROUP", extra);
      }
    }
  }
  if (isRecord(data["dependency-groups"])) {
    for (const [group, list] of Object.entries(data["dependency-groups"])) {
      // `{ include-group = "…" }` entries are not dependencies.
      addPep508List(list, ["dependency-groups", group], "GROUP", group);
    }
  }
  if (uv) addPep508List(uv["dev-dependencies"], ["tool", "uv", "dev-dependencies"], "DEV", "");

  let poetryPython: string | null = null;
  const addPoetryTable = (table: unknown, basePath: string[], kind: DependencyKind, group: string): void => {
    if (!isRecord(table)) return;
    for (const [rawName, value] of Object.entries(table)) {
      if (rawName.toLowerCase() === "python") {
        if (typeof value === "string" && kind === "PROD") poetryPython = value;
        continue;
      }
      const name = normalizePypiName(rawName);
      const common = { name, rawName, kind, group, rangeSyntax: "poetry" as RangeSyntax, file: path, extras: [], marker: null };
      let valuePath: Array<string | number> = [...basePath, rawName];
      let declared: string | null = null;
      let reason: string | null = null;
      let extras: string[] = [];
      if (typeof value === "string") declared = value;
      else if (isRecord(value)) {
        if (typeof value.git === "string") reason = "Git dependency";
        else if (typeof value.path === "string") reason = "Local path dependency";
        else if (typeof value.url === "string") reason = "URL dependency";
        else if (typeof value.file === "string") reason = "Local file dependency";
        else if (typeof value.source === "string") reason = "Private source (not the public PyPI)";
        if (typeof value.version === "string") {
          declared = value.version;
          valuePath = [...valuePath, "version"];
        } else if (!reason) reason = "No version constraint";
        if (Array.isArray(value.extras)) extras = value.extras.filter((e): e is string => typeof e === "string");
      } else if (Array.isArray(value)) reason = "Multiple-constraint dependency";
      else reason = "Not a version constraint";

      if (declared !== null && !reason && !isValidPep440Constraint(declared, "poetry")) reason = "Invalid version constraint";
      const location = located.get(tomlPathKey(valuePath));
      const writable = declared !== null && location?.plain === true;
      dependencies.push({
        ...common,
        extras,
        declared: declared ?? "",
        span: writable && location ? { start: location.span.start, end: location.span.end } : null,
        valuePath,
        valueOffset: { start: 0, end: (declared ?? "").length },
        supported: reason === null,
        ...(reason === null ? {} : { unsupportedReason: reason }),
      });
    }
  };

  if (poetry) {
    addPoetryTable(poetry.dependencies, ["tool", "poetry", "dependencies"], "PROD", "");
    addPoetryTable(poetry["dev-dependencies"], ["tool", "poetry", "dev-dependencies"], "DEV", "");
    if (isRecord(poetry.group)) {
      for (const [group, definition] of Object.entries(poetry.group)) {
        if (isRecord(definition)) {
          addPoetryTable(definition.dependencies, ["tool", "poetry", "group", group, "dependencies"], "GROUP", group);
        }
      }
    }
  }

  const uvWorkspaceTable = uv && isRecord(uv.workspace) ? uv.workspace : null;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

  const projectRequiresPython = project && typeof project["requires-python"] === "string" ? project["requires-python"] : null;
  return {
    projectName:
      project && typeof project.name === "string"
        ? project.name
        : poetry && typeof poetry.name === "string"
          ? poetry.name
          : null,
    requiresPython: projectRequiresPython ?? poetryPython,
    requiresPythonSyntax: projectRequiresPython !== null || poetryPython === null ? "pep440" : "poetry",
    hasToolPoetry: poetry !== null,
    hasToolUv: uv !== null,
    uvWorkspace: uvWorkspaceTable
      ? { members: strings(uvWorkspaceTable.members), exclude: strings(uvWorkspaceTable.exclude) }
      : null,
    dependencies,
    warnings,
  };
}
