import { exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import type { AuthoritySigningKey } from "@trustid/digi-authority";

/**
 * Load Digi authority signing key.
 * Prefer DIGI_AUTHORITY_PRIVATE_JWK (JSON JWK) for multi-instance stability.
 * Fall back to ephemeral generate (dev only — tokens die on restart).
 */
export async function loadAuthoritySigningKey(): Promise<{
  primary: AuthoritySigningKey;
  publicJwks: JWK[];
}> {
  const kid = process.env.DIGI_AUTHORITY_KID?.trim() || "auth-1";
  const raw = process.env.DIGI_AUTHORITY_PRIVATE_JWK?.trim();
  if (raw) {
    const jwk = JSON.parse(raw) as JWK;
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
    return {
      primary: { kid: String(jwk.kid), privateKey, publicJwk },
      publicJwks: [publicJwk, ...prevKeys],
    };
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
