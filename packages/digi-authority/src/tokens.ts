import { exportJWK, generateKeyPair, importJWK, SignJWT, jwtVerify, type JWK } from "jose";
import {
  DIGI_AUTHORITY_ISSUER,
  DIGI_AUTHORITY_TOKEN_TTL_SECONDS,
  type ApprovalMode,
  type AuthorityLimits,
  type AuthorityTokenClaims,
} from "./types.js";

export type AuthoritySigningKey = {
  kid: string;
  privateKey: CryptoKey | Uint8Array;
  publicJwk: JWK;
};

export async function generateAuthoritySigningKey(
  kid = "auth-1"
): Promise<AuthoritySigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";
  return { kid, privateKey, publicJwk };
}

export type MintAuthorityTokenInput = {
  ownerId: string;
  audience: string;
  actor: string;
  actions: string[];
  resources: string[];
  limits: AuthorityLimits;
  approval: ApprovalMode;
  grantId: string;
  grantVersion: number;
  oneTime: boolean;
  jti: string;
  ttlSeconds?: number;
  now?: Date;
  clockSkewSeconds?: number;
};

export async function mintAuthorityToken(
  key: AuthoritySigningKey,
  input: MintAuthorityTokenInput
): Promise<{ token: string; claims: AuthorityTokenClaims }> {
  const now = input.now ?? new Date();
  const ttl = input.ttlSeconds ?? DIGI_AUTHORITY_TOKEN_TTL_SECONDS;
  const skew = input.clockSkewSeconds ?? 0;
  const iat = Math.floor(now.getTime() / 1000);
  const nbf = iat - skew;
  const exp = iat + ttl;

  const claims: AuthorityTokenClaims = {
    iss: DIGI_AUTHORITY_ISSUER,
    sub: input.ownerId,
    aud: input.audience,
    actor: input.actor,
    actions: [...input.actions],
    resources: [...input.resources],
    limits: { ...input.limits },
    approval: input.approval,
    grantId: input.grantId,
    grantVersion: input.grantVersion,
    oneTime: input.oneTime,
    jti: input.jti,
    iat,
    nbf,
    exp,
  };

  const token = await new SignJWT({
    actor: claims.actor,
    actions: claims.actions,
    resources: claims.resources,
    limits: claims.limits,
    approval: claims.approval,
    grantId: claims.grantId,
    grantVersion: claims.grantVersion,
    oneTime: claims.oneTime,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: "JWT" })
    .setIssuer(claims.iss)
    .setSubject(claims.sub)
    .setAudience(claims.aud)
    .setJti(claims.jti)
    .setIssuedAt(claims.iat)
    .setNotBefore(claims.nbf)
    .setExpirationTime(claims.exp)
    .sign(key.privateKey);

  return { token, claims };
}

export type VerifyAuthorityTokenInput = {
  token: string;
  expectedAudience: string;
  expectedActor?: string;
  expectedAction?: string;
  expectedResource?: string;
  publicJwks: JWK[];
  now?: Date;
  clockToleranceSeconds?: number;
};

export type VerifyAuthorityTokenResult =
  | { ok: true; claims: AuthorityTokenClaims }
  | { ok: false; reason: string };

function joseClaim(err: unknown): string {
  if (err && typeof err === "object" && "claim" in err) {
    return String((err as { claim?: string }).claim ?? "");
  }
  return "";
}

export async function verifyAuthorityToken(
  input: VerifyAuthorityTokenInput
): Promise<VerifyAuthorityTokenResult> {
  try {
    const header = JSON.parse(
      Buffer.from(input.token.split(".")[0] ?? "", "base64url").toString("utf8")
    ) as { kid?: string; alg?: string };
    if (header.alg !== "EdDSA") {
      return { ok: false, reason: "bad_alg" };
    }
    const jwk = input.publicJwks.find((k) => k.kid === header.kid);
    if (!jwk) {
      return { ok: false, reason: "unknown_kid" };
    }
    const key = await importJWK(jwk, "EdDSA");
    const { payload } = await jwtVerify(input.token, key, {
      issuer: DIGI_AUTHORITY_ISSUER,
      audience: input.expectedAudience,
      clockTolerance: input.clockToleranceSeconds ?? 5,
      currentDate: input.now,
    });

    const claims: AuthorityTokenClaims = {
      iss: DIGI_AUTHORITY_ISSUER,
      sub: String(payload.sub ?? ""),
      aud: Array.isArray(payload.aud)
        ? String(payload.aud[0])
        : String(payload.aud ?? ""),
      actor: String(payload.actor ?? ""),
      actions: Array.isArray(payload.actions)
        ? (payload.actions as string[])
        : [],
      resources: Array.isArray(payload.resources)
        ? (payload.resources as string[])
        : [],
      limits: (payload.limits as AuthorityLimits) ?? {},
      approval: payload.approval as AuthorityTokenClaims["approval"],
      grantId: String(payload.grantId ?? ""),
      grantVersion: Number(payload.grantVersion ?? 0),
      oneTime: Boolean(payload.oneTime),
      jti: String(payload.jti ?? ""),
      iat: Number(payload.iat ?? 0),
      nbf: Number(payload.nbf ?? 0),
      exp: Number(payload.exp ?? 0),
    };

    if (!claims.sub || !claims.actor || !claims.jti || !claims.grantId) {
      return { ok: false, reason: "malformed" };
    }
    if (input.expectedActor && claims.actor !== input.expectedActor) {
      return { ok: false, reason: "wrong_actor" };
    }
    if (
      input.expectedAction &&
      !claims.actions.includes(input.expectedAction)
    ) {
      return { ok: false, reason: "wrong_action" };
    }
    if (
      input.expectedResource &&
      !claims.resources.includes(input.expectedResource)
    ) {
      return { ok: false, reason: "wrong_resource" };
    }

    return { ok: true, claims };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const claim = joseClaim(err);
    // jose: unexpected "aud" claim value. Match aud before any /exp/ heuristic ù
    // the word "unexpected" contains the substring "exp".
    if (claim === "aud" || msg.includes('"aud"') || /audience/i.test(msg)) {
      return { ok: false, reason: "wrong_audience" };
    }
    if (
      claim === "exp" ||
      msg.includes('"exp"') ||
      /timestamp check failed/i.test(msg) ||
      /jwt expired/i.test(msg)
    ) {
      return { ok: false, reason: "expired" };
    }
    if (claim === "nbf" || msg.includes('"nbf"')) {
      return { ok: false, reason: "not_yet_valid" };
    }
    return { ok: false, reason: "invalid_token" };
  }
}
