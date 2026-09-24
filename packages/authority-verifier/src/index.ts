/**
 * Shared Digi authority token verifier for independent consumers (ElfCom, TV, ).
 * TrustID keys are NEVER used here  only Digi authority JWKS.
 */

import { createRemoteJWKSet, importJWK, jwtVerify, type JWK, type JWTVerifyGetKey } from "jose";
import { isAuthorityClaimsShape } from "@trustid/shared";

/** Logical issuer  not TrustID. Keep stable for T3/T4 consumers. */
export const DIGI_AUTHORITY_ISSUER = "digiconomy-authority";

export const ELFCOM_AUDIENCE = "elfcom";

export type AuthorityLimits = {
  maxAmount?: number;
  currency?: string;
  maxDailyAmount?: number;
  maxMessages?: number;
  maxPosts?: number;
  maxDeployments?: number;
  maxRecipients?: number;
  maxFileSize?: number;
  [key: string]: number | string | undefined;
};

export type VerifiedAuthority = {
  iss: string;
  sub: string; // Digi ownerId
  aud: string;
  actor: string;
  actions: string[];
  resources: string[];
  limits: AuthorityLimits;
  approval: string;
  grantId: string;
  grantVersion: number;
  oneTime: boolean;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  /** TrustID subject when Digi included it for service authorship */
  ownerTrustId: string | null;
};

export type VerifyAuthorityInput = {
  token: string;
  audience: string;
  action: string;
  /** Resource derived from the actual operation (never trust client "resource" alone). */
  resource: string;
  /** Expected actor key (type:id). Required  do not trust X-Actor alone. */
  actor: string;
  /** Optional expected Digi ownerId */
  ownerId?: string;
  publicJwks?: JWK[];
  jwksUrl?: string;
  now?: Date;
  clockToleranceSeconds?: number;
};

export type VerifyAuthorityResult =
  | { ok: true; claims: VerifiedAuthority }
  | { ok: false; reason: string; metric?: string };

/** Structured ElfCom resource grammar. */
export type ElfComResource =
  | { kind: "conversation"; conversationId: string }
  | { kind: "recipient"; trustId: string };

export function parseElfComResource(raw: string): ElfComResource | null {
  const conv = /^elfcom:conversation:([^:]+)$/.exec(raw);
  if (conv?.[1]) return { kind: "conversation", conversationId: conv[1] };
  const recip = /^elfcom:recipient:([^:]+)$/.exec(raw);
  if (recip?.[1]) return { kind: "recipient", trustId: recip[1] };
  return null;
}

export function elfComConversationResource(conversationId: string): string {
  return `elfcom:conversation:${conversationId}`;
}

export function elfComRecipientResource(trustId: string): string {
  return `elfcom:recipient:${trustId}`;
}

function joseClaim(err: unknown): string {
  if (err && typeof err === "object" && "claim" in err) {
    return String((err as { claim?: string }).claim ?? "");
  }
  return "";
}

const remoteCache = new Map<string, JWTVerifyGetKey>();

function getRemoteJwks(url: string): JWTVerifyGetKey {
  let set = remoteCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    remoteCache.set(url, set);
  }
  return set;
}

/** Test helper */
export function __resetAuthorityJwksCache() {
  remoteCache.clear();
}

export async function verifyAuthority(
  input: VerifyAuthorityInput
): Promise<VerifyAuthorityResult> {
  const token = input.token?.trim() ?? "";
  if (!token) {
    return { ok: false, reason: "missing_token", metric: "authority_verify_failure" };
  }

  // Reject obviously non-JWT / alg=none before crypto work
  try {
    const header = JSON.parse(
      Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")
    ) as { alg?: string; kid?: string };
    if (!header.alg || header.alg === "none" || header.alg !== "EdDSA") {
      return { ok: false, reason: "bad_alg", metric: "authority_verify_failure" };
    }
  } catch {
    return { ok: false, reason: "malformed_token", metric: "authority_verify_failure" };
  }

  try {
    let key: CryptoKey | Uint8Array | JWTVerifyGetKey;
    if (input.publicJwks?.length) {
      const header = JSON.parse(
        Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")
      ) as { kid?: string };
      const jwk = input.publicJwks.find((k) => k.kid === header.kid);
      if (!jwk) {
        return { ok: false, reason: "unknown_kid", metric: "authority_verify_failure" };
      }
      key = (await importJWK(jwk, "EdDSA")) as CryptoKey;
    } else if (input.jwksUrl) {
      key = getRemoteJwks(input.jwksUrl);
    } else {
      return { ok: false, reason: "no_jwks", metric: "authority_verify_failure" };
    }

    const { payload } = await jwtVerify(token, key as CryptoKey | JWTVerifyGetKey, {
      algorithms: ["EdDSA"],
      requiredClaims: ["iss", "sub", "aud", "iat", "nbf", "exp", "jti"],
      issuer: DIGI_AUTHORITY_ISSUER,
      audience: input.audience,
      clockTolerance: input.clockToleranceSeconds ?? 0,
      currentDate: input.now,
    });

    if (!isAuthorityClaimsShape(payload)) return { ok: false, reason: "malformed", metric: "authority_verify_failure" };
    if (Number(payload.iat) > Math.floor((input.now ?? new Date()).getTime() / 1000)) return { ok: false, reason: "not_yet_valid" };

    // Identity assertions must never pass  require authority-specific claims
    if (!payload.actor || !payload.actions || !payload.grantId || !payload.jti) {
      return { ok: false, reason: "not_authority_token", metric: "authority_verify_failure" };
    }

    const claims: VerifiedAuthority = {
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
      approval: String(payload.approval ?? ""),
      grantId: String(payload.grantId ?? ""),
      grantVersion: Number(payload.grantVersion ?? 0),
      oneTime: Boolean(payload.oneTime),
      jti: String(payload.jti ?? ""),
      iat: Number(payload.iat ?? 0),
      nbf: Number(payload.nbf ?? 0),
      exp: Number(payload.exp ?? 0),
      ownerTrustId:
        typeof payload.ownerTrustId === "string" ? payload.ownerTrustId : null,
    };

    if (!claims.sub || !claims.actor || !claims.jti || !claims.grantId) {
      return { ok: false, reason: "malformed", metric: "authority_verify_failure" };
    }
    if (input.ownerId && claims.sub !== input.ownerId) {
      return { ok: false, reason: "wrong_owner", metric: "authority_verify_failure" };
    }
    if (claims.actor !== input.actor) {
      return { ok: false, reason: "wrong_actor", metric: "authority_verify_failure" };
    }
    if (!claims.actions.includes(input.action)) {
      return {
        ok: false,
        reason: "wrong_action",
        metric: "authority_verify_failure",
      };
    }
    // Exact resource match  no prefix / substring
    if (!claims.resources.includes(input.resource)) {
      return {
        ok: false,
        reason: "wrong_resource",
        metric: "authority_wrong_resource",
      };
    }

    return { ok: true, claims };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const claim = joseClaim(err);
    if (claim === "aud" || msg.includes('"aud"') || /audience/i.test(msg)) {
      return { ok: false, reason: "wrong_audience", metric: "authority_wrong_audience" };
    }
    if (
      claim === "exp" ||
      msg.includes('"exp"') ||
      /jwt expired/i.test(msg)
    ) {
      return { ok: false, reason: "expired", metric: "authority_expired" };
    }
    if (claim === "nbf" || msg.includes('"nbf"')) {
      return { ok: false, reason: "not_yet_valid", metric: "authority_verify_failure" };
    }
    if (/issuer/i.test(msg) || claim === "iss") {
      return { ok: false, reason: "wrong_issuer", metric: "authority_verify_failure" };
    }
    if (/no matching|JWKS|key/i.test(msg)) {
      // createRemoteJWKSet refreshes once on unknown kid internally
      return { ok: false, reason: "unknown_kid", metric: "authority_verify_failure" };
    }
    return { ok: false, reason: "invalid_token", metric: "authority_verify_failure" };
  }
}

/**
 * Execution gate: offline signature checks alone cannot prove current revocation
 * or remaining usage. The host supplies an authenticated Digi consumption client.
 * Unavailable/invalid consumption fails closed. Never expose the callback to actors.
 */
export async function authorizeAuthority(
  input: VerifyAuthorityInput & {
    consume: (input: { token: string; audience: string; actor: string; action: string; resource: string }) => Promise<{
      decision: string; grantId?: string; jti?: string; reason?: string;
    }>;
  },
): Promise<VerifyAuthorityResult> {
  const verified = await verifyAuthority(input);
  if (!verified.ok) return verified;
  try {
    const current = await input.consume({ token: input.token, audience: input.audience, actor: input.actor, action: input.action, resource: input.resource });
    if (current.decision !== "ALLOW") return { ok: false, reason: current.reason ?? "consume_denied" };
    if (current.grantId !== verified.claims.grantId || current.jti !== verified.claims.jti) return { ok: false, reason: "consume_binding_mismatch" };
    return verified;
  } catch {
    return { ok: false, reason: "authority_unavailable" };
  }
}
