import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { generateTrustId } from "@trustid/shared";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqualHash(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function generateOtp(): string {
  return String(randomInt(100000, 999999));
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function newTrustId(): string {
  return generateTrustId(randomBytes(5));
}
