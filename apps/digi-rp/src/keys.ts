import { exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import type { AuthoritySigningKey } from "@trustid/digi-authority";

/**
 * Load Digi authority signing key.
 * Prefer DIGI_AUTHORITY_PRIVATE_JWK (JSON JWK) for multi-instance stability.
 * Fall back to ephemeral generate (dev only  tokens die on restart).
 */
export async function loadAuthoritySigningKey(): Promise<{
  primary: AuthoritySigningKey;
  publicJwks: JWK[];
}> {
  const kid = process.env.DIGI_AUTHORITY_KID?.trim() || "auth-1";
  const raw = process.env.DIGI_AUTHORITY_PRIVATE_JWK?.trim();
  if (raw) {
    const jwk = JSON.parse(raw) as JWK;
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) {
      throw new Error("DIGI_AUTHORITY_PRIVATE_JWK must be a private Ed25519 key");
    }
    jwk.kid = jwk.kid ?? kid;
    jwk.alg = "EdDSA";
    jwk.use = "sig";
    const privateKey = (await importJWK(jwk, "EdDSA")) as CryptoKey;
    const { d: _d, ...publicJwk } = jwk;
    publicJwk.kid = jwk.kid;
    publicJwk.alg = "EdDSA";
    publicJwk.use = "sig";
    void _d;
    const previous = process.env.DIGI_AUTHORITY_PREVIOUS_PUBLIC_JWKS?.trim();
    const prevKeys: JWK[] = previous ? (JSON.parse(previous) as JWK[]) : [];
    if (!Array.isArray(prevKeys) || prevKeys.some(k => k.kty !== "OKP" || k.crv !== "Ed25519" || !k.x || k.d || k.k)) {
      throw new Error("Previous authority JWKS must contain public Ed25519 keys only");
    }
    return {
      primary: { kid: String(jwk.kid), privateKey, publicJwk },
      publicJwks: [publicJwk, ...prevKeys],
    };
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("DIGI_AUTHORITY_PRIVATE_JWK required in production");
  }
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";
  return {
    primary: { kid, privateKey, publicJwk },
    publicJwks: [publicJwk],
  };
}
