import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
/** 96-bit IV is the NIST-recommended size for GCM. */
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const HEX_RE = /^[0-9a-f]*$/i;

/**
 * Reads and validates TOKEN_ENCRYPTION_KEY (64 hex chars = 32 bytes).
 * Read on every call so key rotation / test overrides take effect without a restart.
 */
function getKey(): Buffer {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  }
  if (hex.length !== 64 || !HEX_RE.test(hex)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypts a plaintext token with AES-256-GCM.
 * @returns `ivHex:authTagHex:encryptedHex`
 */
export function encryptToken(plainText: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts a value produced by {@link encryptToken}.
 * Throws if the payload is malformed, the key is wrong, or the ciphertext/tag was tampered with.
 */
export function decryptToken(cipherText: string): string {
  const parts = cipherText.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format: expected ivHex:authTagHex:encryptedHex");
  }
  const [ivHex, authTagHex, encryptedHex] = parts as [string, string, string];
  if (
    ivHex.length !== IV_LENGTH * 2 ||
    authTagHex.length !== AUTH_TAG_LENGTH * 2 ||
    encryptedHex.length % 2 !== 0 ||
    !HEX_RE.test(ivHex) ||
    !HEX_RE.test(authTagHex) ||
    !HEX_RE.test(encryptedHex)
  ) {
    throw new Error("Invalid encrypted token format");
  }

  const key = getKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"), {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  // decipher.final() throws "Unsupported state or unable to authenticate data" on tampering.
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
