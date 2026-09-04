import { createHash, createSecretKey, randomUUID } from "node:crypto";
import * as jose from "jose";
import { config } from "../../lib/config.js";

/**
 * Mint a short-lived ElfCom capability JWT (HS256) so TrustID can call
 * POST /v1/devices/register on behalf of a signed-in user.
 * Must share LIFEOS_JWT_SECRET / iss / aud with elfcom-node.
 */
export async function mintElfComCapabilityJwt(input: {
  trustId: string;
  sessionId?: string;
  scopes?: string[];
  expiresInSeconds?: number;
}): Promise<string> {
  const secret = config.elfcom.capabilityJwtSecret;
  const key = createSecretKey(Buffer.from(secret, "utf8"));
  const sid = input.sessionId ?? `trustid-push:${input.trustId}:${randomUUID().slice(0, 8)}`;
  const zkBind = createHash("sha256")
    .update(`trustid:push:${input.trustId}`)
    .digest("base64url");

  return new jose.SignJWT({
    sid,
    zk_bind: zkBind,
    scp: input.scopes ?? ["session:bind", "notify:send"],
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(config.elfcom.capabilityJwtIss)
    .setAudience(config.elfcom.capabilityJwtAud)
    .setSubject(input.trustId)
    .setIssuedAt()
    .setExpirationTime(`${input.expiresInSeconds ?? 300}s`)
    .sign(key);
}
