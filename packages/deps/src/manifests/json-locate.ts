/**
 * Locates string values in a JSON document: `JSON.parse` gives values, this scanner gives the offsets of every
 * string value (by key path), so rewrites can be span edits. Also tolerates trailing commas (for `bun.lock`).
 */
import type { TextSpan } from "../types.js";

export interface LocatedString {
  /** Span of the raw string content (between the quotes). */
  span: TextSpan;
  /** `true` when the raw content has no escape sequences (raw text = decoded value). */
  plain: boolean;
}

export class JsonScanError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "JsonScanError";
  }
}

/** Key path → string location, path encoded with {@link jsonPathKey}. */
export type JsonLocations = Map<string, LocatedString>;

export function jsonPathKey(path: ReadonlyArray<string | number>): string {
  return JSON.stringify(path);
}

/**
 * Scans `text` and records every string value up to `maxDepth` levels deep. With `allowTrailingCommas`, also
 * returns the text with trailing commas blanked (same length, so offsets are kept) for `JSON.parse`.
 */
export function locateJsonStrings(
  text: string,
  options: { maxDepth?: number; allowTrailingCommas?: boolean; allowComments?: boolean } = {},
): { locations: JsonLocations; cleaned: string } {
  const maxDepth = options.maxDepth ?? 4;
  const locations: JsonLocations = new Map();
  // Offsets blanked out in `cleaned` (trailing commas, comment characters); same length keeps offsets valid.
  const blanks: Array<[number, number]> = [];
  let i = 0;

  const fail = (message: string): never => {
    throw new JsonScanError(message, i);
  };

  const skipWhitespace = (): void => {
    for (;;) {
      const char = text[i];
      if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\uFEFF") i++;
      else if (options.allowComments && char === "/" && text[i + 1] === "/") {
        const start = i;
        while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
        blanks.push([start, i]);
      } else if (options.allowComments && char === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end === -1) fail("Unterminated comment");
        for (let at = i; at < end + 2; at++) if (text[at] !== "\n" && text[at] !== "\r") blanks.push([at, at + 1]);
        i = end + 2;
      } else return;
    }
  };

  const readString = (): { value: string; span: TextSpan; plain: boolean } => {
    if (text[i] !== '"') fail("Expected string");
    const start = ++i;
    let plain = true;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        plain = false;
        i += 2;
      } else if (text[i] === "\n") fail("Newline in string");
      else i++;
    }
    if (i >= text.length) fail("Unterminated string");
    const end = i++;
    const raw = text.slice(start - 1, end + 1);
    let value: string;
    try {
      value = JSON.parse(raw) as string;
    } catch {
      return fail("Invalid string");
    }
    return { value, span: { start, end }, plain };
  };

  const readValue = (path: Array<string | number>): void => {
    skipWhitespace();
    const char = text[i];
    if (char === "{") {
      i++;
      skipWhitespace();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        skipWhitespace();
        if (options.allowTrailingCommas && text[i] === "}") {
          i++;
          return;
        }
        const key = readString().value;
        skipWhitespace();
        if (text[i] !== ":") fail("Expected ':'");
        i++;
        readValue([...path, key]);
        skipWhitespace();
        if (text[i] === ",") {
          const commaAt = i++;
          skipWhitespace();
          if (text[i] === "}") {
            if (!options.allowTrailingCommas) fail("Trailing comma");
            blanks.push([commaAt, commaAt + 1]);
          }
          continue;
        }
        if (text[i] === "}") {
          i++;
          return;
        }
        fail("Expected ',' or '}'");
      }
    }
    if (char === "[") {
      i++;
      skipWhitespace();
      if (text[i] === "]") {
        i++;
        return;
      }
      let index = 0;
      for (;;) {
        skipWhitespace();
        if (options.allowTrailingCommas && text[i] === "]") {
          i++;
          return;
        }
        readValue([...path, index++]);
        skipWhitespace();
        if (text[i] === ",") {
          const commaAt = i++;
          skipWhitespace();
          if (text[i] === "]") {
            if (!options.allowTrailingCommas) fail("Trailing comma");
            blanks.push([commaAt, commaAt + 1]);
          }
          continue;
        }
        if (text[i] === "]") {
          i++;
          return;
        }
        fail("Expected ',' or ']'");
      }
    }
    if (char === '"') {
      const { span, plain } = readString();
      if (path.length <= maxDepth) locations.set(jsonPathKey(path), { span, plain });
      return;
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
    if (!literal) fail("Unexpected token");
    i += (literal as RegExpExecArray)[0].length;
  };

  readValue([]);
  skipWhitespace();
  if (i < text.length) fail("Unexpected trailing content");
  if (blanks.length === 0) return { locations, cleaned: text };
  blanks.sort((a, b) => a[0] - b[0]);
  let cleaned = "";
  let at = 0;
  for (const [start, end] of blanks) {
    cleaned += text.slice(at, start) + " ".repeat(end - start);
    at = end;
  }
  return { locations, cleaned: cleaned + text.slice(at) };
}

/** `JSON.parse` for JSONC-ish text (trailing commas, comments), as written by Bun in `bun.lock`. */
export function parseJsonWithTrailingCommas(text: string): unknown {
  const { cleaned } = locateJsonStrings(text, { maxDepth: 0, allowTrailingCommas: true, allowComments: true });
  return JSON.parse(cleaned.charCodeAt(0) === 0xfeff ? cleaned.slice(1) : cleaned);
}
