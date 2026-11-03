/**
 * A small TOML tokenizer that records the location of every string value by key path. `smol-toml` gives the
 * values, but TOML parsers do not expose positions, so span edits need this (Slice 08 §3.2 step 4).
 *
 * It understands table headers, array-of-table headers, dotted / quoted keys, all four string forms, arrays and
 * inline tables (nested), comments and other scalars (skipped). Values are not validated: run `smol-toml` first.
 */
import type { TextSpan } from "../types.js";

export interface TomlLocatedString {
  /** Span of the raw string content (between the quotes). */
  span: TextSpan;
  /** Raw content equals the decoded value (literal strings, basic strings without escapes, single line). */
  plain: boolean;
}

export type TomlPath = ReadonlyArray<string | number>;

export function tomlPathKey(path: TomlPath): string {
  return JSON.stringify(path);
}

export class TomlLocateError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "TomlLocateError";
  }
}

/** Key path → location of every string value in the document. */
export function locateTomlStrings(text: string): Map<string, TomlLocatedString> {
  const located = new Map<string, TomlLocatedString>();
  const arrayTableCounts = new Map<string, number>();
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let table: Array<string | number> = [];

  const fail = (message: string): never => {
    throw new TomlLocateError(message, i);
  };
  const skipInline = (): void => {
    while (text[i] === " " || text[i] === "\t") i++;
  };
  const skipComment = (): void => {
    if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++;
  };
  const skipBlank = (): void => {
    for (;;) {
      skipInline();
      skipComment();
      if (text[i] === "\n" || text[i] === "\r") i++;
      else return;
    }
  };

  const readQuotedKey = (): string => {
    const quote = text[i];
    const start = ++i;
    while (i < text.length && text[i] !== quote) {
      if (quote === '"' && text[i] === "\\") i++;
      if (text[i] === "\n") fail("Newline in key");
      i++;
    }
    const raw = text.slice(start, i++);
    if (quote === "'") return raw;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return raw;
    }
  };

  const readKey = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipInline();
      if (text[i] === '"' || text[i] === "'") parts.push(readQuotedKey());
      else {
        const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 256));
        if (!match) fail("Expected key");
        parts.push((match as RegExpExecArray)[0]);
        i += (match as RegExpExecArray)[0].length;
      }
      skipInline();
      if (text[i] !== ".") return parts;
      i++;
    }
  };

  const readValue = (path: Array<string | number>): void => {
    skipInline();
    const char = text[i];
    if (char === '"' || char === "'") {
      const triple = text.startsWith(char.repeat(3), i);
      if (triple) {
        const start = i + 3;
        let end = text.indexOf(char.repeat(3), start);
        if (end === -1) fail("Unterminated multi-line string");
        // Up to two extra quotes may close the string (`""""` / `"""""`).
        while (text[end + 3] === char) end++;
        if (char === '"') {
          // Skip escaped closing quotes (`\"""`).
          let at = start;
          for (;;) {
            const close = text.indexOf('"""', at);
            if (close === -1) fail("Unterminated multi-line string");
            let backslashes = 0;
            for (let k = close - 1; k >= start && text[k] === "\\"; k--) backslashes++;
            if (backslashes % 2 === 0) {
              end = close;
              while (text[end + 3] === '"') end++;
              break;
            }
            at = close + 1;
          }
        }
        located.set(tomlPathKey(path), { span: { start, end }, plain: false });
        i = end + 3;
        return;
      }
      const start = ++i;
      let plain = true;
      while (i < text.length && text[i] !== char) {
        if (text[i] === "\n") fail("Newline in string");
        if (char === '"' && text[i] === "\\") {
          plain = false;
          i++;
        }
        i++;
      }
      if (i >= text.length) fail("Unterminated string");
      located.set(tomlPathKey(path), { span: { start, end: i }, plain });
      i++;
      return;
    }
    if (char === "[") {
      i++;
      let index = 0;
      for (;;) {
        skipBlank();
        if (text[i] === "]") {
          i++;
          return;
        }
        readValue([...path, index++]);
        skipBlank();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return;
        }
        fail("Expected ',' or ']'");
      }
    }
    if (char === "{") {
      i++;
      skipInline();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        skipBlank();
        if (text[i] === "}") {
          i++;
          return;
        }
        const key = readKey();
        if (text[i] !== "=") fail("Expected '='");
        i++;
        readValue([...path, ...key]);
        skipBlank();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return;
        }
        fail("Expected ',' or '}'");
      }
    }
    // Numbers, booleans, dates (a local date-time may contain one space before the time).
    const scalar = /^[^\s,\]}#]+(?: \d{2}:\d{2}[^\s,\]}#]*)?/.exec(text.slice(i, i + 128));
    if (!scalar) fail("Expected value");
    i += (scalar as RegExpExecArray)[0].length;
  };

  while (i < text.length) {
    skipBlank();
    if (i >= text.length) break;
    if (text[i] === "[") {
      const isArray = text[i + 1] === "[";
      i += isArray ? 2 : 1;
      const key = readKey();
      if (text[i] !== "]" || (isArray && text[i + 1] !== "]")) fail("Expected ']'");
      i += isArray ? 2 : 1;
      if (isArray) {
        const pathKey = tomlPathKey(key);
        const index = arrayTableCounts.get(pathKey) ?? 0;
        arrayTableCounts.set(pathKey, index + 1);
        table = [...key, index];
      } else table = key;
      continue;
    }
    const key = readKey();
    if (text[i] !== "=") fail("Expected '='");
    i++;
    readValue([...table, ...key]);
    skipInline();
    skipComment();
    if (i < text.length && text[i] !== "\n" && text[i] !== "\r") fail("Expected end of line");
  }
  return located;
}
