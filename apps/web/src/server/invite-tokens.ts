import { createHash, randomBytes } from "node:crypto";

/** 256-bit URL-safe token (43 base64url chars). Only its hash is stored. */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
