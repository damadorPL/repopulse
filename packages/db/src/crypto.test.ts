import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "./crypto";

const TEST_KEY = randomBytes(32).toString("hex");

/** Flip one hex nibble at `index` so the value stays valid hex but changes. */
function flipHexChar(hex: string, index: number): string {
  const c = hex[index]!;
  const flipped = c === "0" ? "1" : "0";
  return hex.slice(0, index) + flipped + hex.slice(index + 1);
}

describe("encryptToken / decryptToken", () => {
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it("round-trips a GitHub token", () => {
    const token = "gho_16C7e42F292c6912E7710c838347Ae178B4a";
    expect(decryptToken(encryptToken(token))).toBe(token);
  });

  it("round-trips empty and unicode strings", () => {
    expect(decryptToken(encryptToken(""))).toBe("");
    expect(decryptToken(encryptToken("tökên-🔐"))).toBe("tökên-🔐");
  });

  it("emits ivHex:authTagHex:encryptedHex with a random IV", () => {
    const a = encryptToken("same");
    const b = encryptToken("same");
    expect(a).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(a).not.toBe(b);
  });

  it("throws on tampered ciphertext", () => {
    const [iv, tag, enc] = encryptToken("secret-token").split(":") as [string, string, string];
    expect(() => decryptToken(`${iv}:${tag}:${flipHexChar(enc, 0)}`)).toThrow();
  });

  it("throws on tampered auth tag or IV", () => {
    const [iv, tag, enc] = encryptToken("secret-token").split(":") as [string, string, string];
    expect(() => decryptToken(`${iv}:${flipHexChar(tag, 5)}:${enc}`)).toThrow();
    expect(() => decryptToken(`${flipHexChar(iv, 3)}:${tag}:${enc}`)).toThrow();
  });

  it("throws when decrypting with a different key", () => {
    const cipherText = encryptToken("secret-token");
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    expect(() => decryptToken(cipherText)).toThrow();
  });

  it("throws on malformed payloads", () => {
    expect(() => decryptToken("not-a-token")).toThrow(/format/);
    expect(() => decryptToken("aa:bb:cc")).toThrow(/format/);
    expect(() => decryptToken("zz".repeat(12) + ":" + "00".repeat(16) + ":00")).toThrow(/format/);
  });

  it("rejects missing or invalid keys", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encryptToken("x")).toThrow(/not set/);
    process.env.TOKEN_ENCRYPTION_KEY = "abc123";
    expect(() => encryptToken("x")).toThrow(/64-character/);
  });
});
