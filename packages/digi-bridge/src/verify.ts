/**
 * Digi-side TrustID assertion verification (Phase T2).
 * Never trusts decoded claims without cryptographic verification.
 */
import * as jose from "jose";
import {
  DIGI_AUDIENCE_PRODUCTION,
  DIGI_AUDIENCE_DEV,
  resolveDigiAudience,
} from "@trustid/shared";

export const ALLOWED_ASSERTION_ALGS = ["EdDSA"] as const;

export type DigiVerifyFailureReason =
  | "malformed_jwt"
  | "bad_signature"
  | "expired"
  | "not_active"
  | "future_iat"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "missing_audience"
  | "unknown_kid"
  | "unsupported_alg"
  | "alg_none"
  | "missing_sub"
  | "malformed_sub"
  | "missing_jti"
  | "replay"
  | "missing_claims";

export type DigiVerifySuccess = {
  ok: true;
  issuer: string;
  audience: string;
  subject: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  kid: string;
};

export type DigiVerifyFailure = {
  ok: false;
  reason: DigiVerifyFailureReason;
};

export type DigiVerifyResult = DigiVerifySuccess | DigiVerifyFailure;

export type JwksCache = {
  getKey: (header: {
    alg?: string;
    kid?: string;
  }) => Promise<CryptoKey | Uint8Array | null>;
  refresh: () => Promise<void>;
};

const MAX_IAT_SKEW_SEC = 120;

function isAllowedAudience(aud: string, expected: string): boolean {
  return aud === expected;
}

function normalizeSubject(sub: unknown): string | null {
  if (typeof sub !== "string") return null;
  const s = sub.trim();
  // TrustID subjects look like TD-ù ; allow general non-empty stable ids.
  if (s.length < 3 || s.length > 128) return null;
  if (/\s/.test(s)) return null;
  return s;
}

/**
 * Create a JWKS cache with kid refresh-once semantics.
 */
export function createJwksCache(input: {
  jwksUrl: string;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
}): JwksCache {
  const ttlMs = input.ttlMs ?? 5 * 60_000;
  const fetchFn = input.fetchImpl ?? fetch;
  let keys: jose.JWK[] = [];
  let loadedAt = 0;
  let localJwks: ReturnType<typeof jose.createLocalJWKSet> | null = null;

  async function load() {
    const res = await fetchFn(input.jwksUrl, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`jwks_http_${res.status}`);
    const body = (await res.json()) as { keys?: jose.JWK[] };
    keys = Array.isArray(body.keys) ? body.keys : [];
    localJwks = jose.createLocalJWKSet({ keys });
    loadedAt = Date.now();
  }

  async function ensureFresh(force = false) {
    if (force || !localJwks || Date.now() - loadedAt > ttlMs) {
      await load();
    }
  }

  return {
    async refresh() {
      await load();
    },
    async getKey(header) {
      if (header.alg === "none" || header.alg === "None") return null;
      if (
        !header.alg ||
        !(ALLOWED_ASSERTION_ALGS as readonly string[]).includes(header.alg)
      ) {
        return null;
      }
      await ensureFresh(false);
      try {
        return (await localJwks!(
          header as jose.JWTHeaderParameters,
        )) as CryptoKey;
      } catch {
        // Unknown kid ? refresh once then retry
        await ensureFresh(true);
        try {
          return (await localJwks!(
            header as jose.JWTHeaderParameters,
          )) as CryptoKey;
        } catch {
          return null;
        }
      }
    },
  };
}

export async function verifyDigiAssertion(input: {
  assertion: string;
  expectedIssuer: string;
  expectedAudience?: string;
  jwks: JwksCache;
  nowSec?: number;
}): Promise<DigiVerifyResult> {
  const expectedAudience =
    input.expectedAudience ?? resolveDigiAudience(process.env.NODE_ENV);
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);

  if (!input.assertion || typeof input.assertion !== "string") {
    return { ok: false, reason: "malformed_jwt" };
  }

  let protectedHeader: { alg?: string; kid?: string };
  try {
    protectedHeader = jose.decodeProtectedHeader(input.assertion);
  } catch {
    return { ok: false, reason: "malformed_jwt" };
  }

  if (protectedHeader.alg === "none" || protectedHeader.alg === "None") {
    return { ok: false, reason: "alg_none" };
  }
  if (
    !(ALLOWED_ASSERTION_ALGS as readonly string[]).includes(
      String(protectedHeader.alg),
    )
  ) {
    return { ok: false, reason: "unsupported_alg" };
  }
  if (!protectedHeader.kid) {
    return { ok: false, reason: "unknown_kid" };
  }

  const key = await input.jwks.getKey(protectedHeader);
  if (!key) {
    return { ok: false, reason: "unknown_kid" };
  }

  let payload: jose.JWTPayload;
  try {
    const verified = await jose.jwtVerify(input.assertion, key, {
      algorithms: [...ALLOWED_ASSERTION_ALGS],
      issuer: input.expectedIssuer,
      audience: expectedAudience,
      clockTolerance: 5,
      currentDate: new Date(nowSec * 1000),
    });
    payload = verified.payload;
  } catch (err) {
    if (err instanceof jose.errors.JWTExpired) {
      return { ok: false, reason: "expired" };
    }
    if (err instanceof jose.errors.JWTClaimValidationFailed) {
      const claim = String(err.claim ?? "");
      if (claim === "exp") return { ok: false, reason: "expired" };
      if (claim === "nbf") return { ok: false, reason: "not_active" };
      if (claim === "iss") return { ok: false, reason: "issuer_mismatch" };
      if (claim === "aud") {
        try {
          const decoded = jose.decodeJwt(input.assertion);
          if (decoded.aud == null) {
            return { ok: false, reason: "missing_audience" };
          }
        } catch {
          /* ignore */
        }
        return { ok: false, reason: "audience_mismatch" };
      }
      return { ok: false, reason: "missing_claims" };
    }
    if (err instanceof jose.errors.JWSSignatureVerificationFailed) {
      return { ok: false, reason: "bad_signature" };
    }
    return { ok: false, reason: "bad_signature" };
  }

  // Temporal / claim checks that jose may not surface as our preferred reasons
  // (e.g. future iat with matching nbf).
  {
    const iatEarly = typeof payload.iat === "number" ? payload.iat : NaN;
    const nbfEarly = typeof payload.nbf === "number" ? payload.nbf : iatEarly;
    if (Number.isFinite(iatEarly) && iatEarly > nowSec + MAX_IAT_SKEW_SEC) {
      return { ok: false, reason: "future_iat" };
    }
    if (Number.isFinite(nbfEarly) && nbfEarly > nowSec + 5) {
      return { ok: false, reason: "not_active" };
    }
  }

  if (payload.iss !== input.expectedIssuer) {
    return { ok: false, reason: "issuer_mismatch" };
  }

  const aud = payload.aud;
  if (aud == null) return { ok: false, reason: "missing_audience" };
  const audStr = Array.isArray(aud) ? aud[0] : aud;
  if (typeof audStr !== "string" || !isAllowedAudience(audStr, expectedAudience)) {
    return { ok: false, reason: "audience_mismatch" };
  }

  // Reject LifeOS / other known product audiences even if misconfigured expected
  if (
    audStr === "lifeos" ||
    (audStr.startsWith("lifeos") && audStr !== expectedAudience)
  ) {
    return { ok: false, reason: "audience_mismatch" };
  }

  const sub = normalizeSubject(payload.sub);
  if (payload.sub == null) return { ok: false, reason: "missing_sub" };
  if (!sub) return { ok: false, reason: "malformed_sub" };

  const jti = typeof payload.jti === "string" ? payload.jti.trim() : "";
  if (!jti) return { ok: false, reason: "missing_jti" };

  const iat = typeof payload.iat === "number" ? payload.iat : NaN;
  const nbf = typeof payload.nbf === "number" ? payload.nbf : iat;
  const exp = typeof payload.exp === "number" ? payload.exp : NaN;
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) {
    return { ok: false, reason: "missing_claims" };
  }
  if (iat > nowSec + MAX_IAT_SKEW_SEC) {
    return { ok: false, reason: "future_iat" };
  }
  if (nbf > nowSec + 5) {
    return { ok: false, reason: "not_active" };
  }
  if (exp <= nowSec) {
    return { ok: false, reason: "expired" };
  }

  return {
    ok: true,
    issuer: String(payload.iss),
    audience: audStr,
    subject: sub,
    jti,
    iat,
    nbf,
    exp,
    kid: String(protectedHeader.kid),
  };
}

export {
  DIGI_AUDIENCE_PRODUCTION,
  DIGI_AUDIENCE_DEV,
  resolveDigiAudience,
};
