/** Splits a PEP 508 requirement string (`name[extra]>=1.0; marker`) into its parts with offsets. */
import { isValidPep440Constraint } from "../versions/pep440.js";

export interface Pep508Requirement {
  name: string;
  extras: string[];
  /** The specifier as written, without parentheses: `">=1.0,<2"`, `""` when unpinned. */
  specifier: string;
  /** Offsets of `specifier` in the input. */
  specStart: number;
  specEnd: number;
  marker: string | null;
  /** `name @ url` direct reference. */
  url: string | null;
  /** The specifier is a valid PEP 440 specifier set. */
  valid: boolean;
}

/** `null` when the string does not start with a valid name. */
export function parsePep508(input: string): Pep508Requirement | null {
  let i = 0;
  while (input[i] === " " || input[i] === "\t") i++;
  const nameMatch = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/.exec(input.slice(i));
  if (!nameMatch) return null;
  const name = nameMatch[0];
  i += name.length;
  const skip = (): void => {
    while (input[i] === " " || input[i] === "\t") i++;
  };
  skip();
  let extras: string[] = [];
  if (input[i] === "[") {
    const close = input.indexOf("]", i);
    if (close === -1) return null;
    extras = input
      .slice(i + 1, close)
      .split(",")
      .map((extra) => extra.trim())
      .filter(Boolean);
    i = close + 1;
    skip();
  }
  const semicolon = input.indexOf(";", i);
  const rest = semicolon === -1 ? input.slice(i) : input.slice(i, semicolon);
  const marker = semicolon === -1 ? null : input.slice(semicolon + 1).trim() || null;
  if (rest.trimStart().startsWith("@")) {
    return {
      name,
      extras,
      specifier: "",
      specStart: i,
      specEnd: i,
      marker: null,
      url: input.slice(input.indexOf("@", i) + 1).trim(),
      valid: false,
    };
  }
  let specStart = i;
  let specEnd = i + rest.trimEnd().length;
  if (input[specStart] === "(" && input[specEnd - 1] === ")") {
    specStart++;
    specEnd--;
    while (input[specStart] === " ") specStart++;
    while (specEnd > specStart && input[specEnd - 1] === " ") specEnd--;
  }
  const specifier = input.slice(specStart, specEnd);
  return {
    name,
    extras,
    specifier,
    specStart,
    specEnd,
    marker,
    url: null,
    valid: isValidPep440Constraint(specifier, "pep440"),
  };
}
