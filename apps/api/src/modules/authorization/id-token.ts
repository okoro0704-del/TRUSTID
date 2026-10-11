/**
 * OIDC id_token for the authorization-code flow.
 *
 * Signed with the TrustID signing key advertised at the discovery jwks_uri.
 * Audience is the client that redeemed the code (never a shared "Portal"
 * audience), so a token minted for one client is rejected by another.
 *
 * An id_token proves who signed in; it is not an access token. Protected
 * routes accept only opaque access tokens looked up server-side, so a JWT
 * presented as a bearer never authorizes anything.
 */
import { createHash, randomUUID } from "node:crypto";
import * as jose from "jose";
import { config } from "../../lib/config.js";
import { activeSigningKey, getJwks } from "../verified-identity/assertions.js";

export const ID_TOKEN_TTL_SECONDS = 300;
export const ID_TOKEN_SIGNING_ALGS = ["EdDSA"] as const;

/**
 * at_hash binds the access token returned in the same token response to this id_token (OIDC Core
 * §3.1.3.6): base64url of the left half of the hash of the ASCII access token. For EdDSA/Ed25519 the
 * hash is SHA-512. A relying party that checks it knows the opaque access token it is about to use
 * was issued to its own client in that exchange, not substituted from another client.
 */
export function accessTokenHash(accessToken: string): string {
  const digest = createHash("sha512").update(accessToken, "ascii").digest();
  return digest.subarray(0, digest.length / 2).toString("base64url");
}

export async function issueIdToken(input: {
  trustId: string;
  clientId: string;
  nonce?: string | null;
  authTime?: Date | null;
  /** The access token issued in the same response; adds at_hash. */
  accessToken?: string;
}): Promise<string> {
  const key = await activeSigningKey();
  const claims: jose.JWTPayload = { azp: input.clientId };
  if (input.accessToken) claims.at_hash = accessTokenHash(input.accessToken);
  if (input.nonce) claims.nonce = input.nonce;
  if (input.authTime) claims.auth_time = Math.floor(input.authTime.getTime() / 1000);
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: "JWT" })
    .setIssuer(config.oidcIssuer)
    .setSubject(input.trustId)
    .setAudience(input.clientId)
    .setIssuedAt()
    .setExpirationTime(`${ID_TOKEN_TTL_SECONDS}s`)
    .setJti(randomUUID())
    .sign(key.privateKey);
}

export type IdTokenVerificationError =
  | "invalid_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_azp"
  | "nonce_mismatch"
  | "at_hash_mismatch"
  | "expired"
  | "malformed";

export class IdTokenError extends Error {
  constructor(readonly reason: IdTokenVerificationError) {
    super(`id_token rejected: ${reason}`);
    this.name = "IdTokenError";
  }
}

/**
 * Reference relying-party verification (what a client such as Portal must do).
 * `jwks` is the document from jwks_uri; `nonce` is the value the client sent
 * on /oauth/authorize, or null if it sent none.
 */
export async function verifyIdToken(input: {
  idToken: string;
  clientId: string;
  nonce: string | null;
  issuer?: string;
  jwks?: jose.JSONWebKeySet;
  now?: Date;
  /** When given, the id_token must carry a matching at_hash (token substitution defence). */
  accessToken?: string;
}): Promise<jose.JWTPayload> {
  const jwks = jose.createLocalJWKSet(input.jwks ?? (await getJwks()));
  let payload: jose.JWTPayload;
  try {
    ({ payload } = await jose.jwtVerify(input.idToken, jwks, {
      issuer: input.issuer ?? config.oidcIssuer,
      audience: input.clientId,
      algorithms: [...ID_TOKEN_SIGNING_ALGS],
      currentDate: input.now,
    }));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ERR_JWT_EXPIRED") throw new IdTokenError("expired");
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      const claim = (err as { claim?: string }).claim;
      if (claim === "iss") throw new IdTokenError("wrong_issuer");
      if (claim === "aud") throw new IdTokenError("wrong_audience");
    }
    if (code === "ERR_JWS_INVALID" || code === "ERR_JWT_INVALID") throw new IdTokenError("malformed");
    throw new IdTokenError("invalid_signature");
  }
  // A token with several audiences must name this client as the authorized party.
  if (payload.azp !== undefined && payload.azp !== input.clientId) throw new IdTokenError("wrong_azp");
  if ((payload.nonce ?? null) !== input.nonce) throw new IdTokenError("nonce_mismatch");
  if (input.accessToken !== undefined && payload.at_hash !== accessTokenHash(input.accessToken)) {
    throw new IdTokenError("at_hash_mismatch");
  }
  return payload;
}
