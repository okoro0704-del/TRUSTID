function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function siteUrl(): string | undefined {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
}

/** Normalize to scheme://host (no path / trailing slash). */
function normalizeOrigin(raw?: string | null): string | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function derivedOrigin(): string {
  return (
    normalizeOrigin(process.env.WEBAUTHN_ORIGIN) ||
    normalizeOrigin(siteUrl()) ||
    "http://localhost:5173"
  );
}

function derivedRpId(): string {
  if (process.env.WEBAUTHN_RP_ID?.trim()) return process.env.WEBAUTHN_RP_ID.trim();
  try {
    return new URL(derivedOrigin()).hostname;
  } catch {
    return "localhost";
  }
}

/**
 * All origins allowed for WebAuthn verification.
 * PWA is on Netlify; API is on Railway — RP ID/origin must match the browser host,
 * not the Railway hostname. Accept WEBAUTHN_ORIGIN, WEBAUTHN_ORIGINS, CORS_ORIGINS,
 * and https://{rpID} so a wrong single WEBAUTHN_ORIGIN cannot break login.
 */
function derivedOrigins(): string[] {
  const origins = new Set<string>();
  const add = (raw?: string | null) => {
    const o = normalizeOrigin(raw);
    if (o) origins.add(o);
  };

  add(process.env.WEBAUTHN_ORIGIN);
  add(siteUrl());
  for (const part of (process.env.WEBAUTHN_ORIGINS ?? "").split(",")) add(part);
  for (const part of (process.env.CORS_ORIGINS ?? "").split(",")) add(part);

  const rp = derivedRpId();
  if (rp === "localhost") {
    add("http://localhost:5173");
    add("http://localhost:5174");
  } else {
    add(`https://${rp}`);
  }

  if (!origins.size) add("http://localhost:5173");
  return [...origins];
}

/** Lazy config so Netlify/Railway can set URL / WEBAUTHN_* before first use. */
export const config = {
  get port() {
    return Number(process.env.PORT ?? 8787);
  },
  get host() {
    return process.env.HOST ?? "0.0.0.0";
  },
  get nodeEnv() {
    return process.env.NODE_ENV ?? "development";
  },
  get isDev() {
    return (process.env.NODE_ENV ?? "development") !== "production";
  },
  get cookieSecret() {
    return required(
      "COOKIE_SECRET",
      process.env.SESSION_SECRET || "dev-cookie-secret-change-in-production",
    );
  },
  get sessionTtlHours() {
    return Number(process.env.SESSION_TTL_HOURS ?? 168);
  },
  get otpTtlMinutes() {
    return Number(process.env.OTP_TTL_MINUTES ?? 10);
  },
  /** Pending cross-device approval request lifetime */
  get deviceApprovalTtlMinutes() {
    return Number(process.env.DEVICE_APPROVAL_TTL_MINUTES ?? 10);
  },
  /** Temporary (non-trusted) session lifetime */
  get temporarySessionHours() {
    return Number(process.env.TEMPORARY_SESSION_HOURS ?? 8);
  },
  /** ElfCom sovereign messaging node — Universal Push Primitive + realtime */
  get elfcom() {
    const mode = (process.env.ELFCOM_MODE ?? "unbound") as "unbound" | "http";
    const baseUrl =
      process.env.ELFCOM_API_URL ??
      process.env.ELFCOM_BASE_URL ??
      "http://localhost:8791";
    return {
      mode,
      baseUrl,
      nodeSecret:
        process.env.ELFCOM_NODE_SECRET ??
        process.env.LIFEOS_JWT_SECRET ??
        "elfcom-dev-node-secret-change-me",
      /** BaaS key for POST /v1/baas/notify (maps to trust_id_app) */
      baasApiKey: process.env.ELFCOM_BAAS_API_KEY ?? "",
      appId: process.env.ELFCOM_APP_ID ?? "trust_id_app",
      /** Shared with elfcom-node LIFEOS_JWT_* for device register JWTs */
      capabilityJwtSecret:
        process.env.ELFCOM_CAPABILITY_JWT_SECRET ??
        process.env.LIFEOS_JWT_SECRET ??
        process.env.ELFCOM_NODE_SECRET ??
        "elfcom-dev-node-secret-change-me",
      capabilityJwtIss: process.env.LIFEOS_JWT_ISS ?? "lifeos",
      capabilityJwtAud: process.env.LIFEOS_JWT_AUD ?? "elfcom",
    };
  },
  /** DataZone sovereign-drive — object storage + sync relay */
  get datazone() {
    const mode = (process.env.DATAZONE_MODE ?? "unbound") as "unbound" | "http";
    return {
      mode,
      baseUrl:
        process.env.DATAZONE_BASE_URL ??
        "https://sovereign-drive-engine-production.up.railway.app",
      jwtSecret:
        process.env.DATAZONE_JWT_SECRET ??
        process.env.TRUST_ID_JWT_SECRET ??
        "dev-datazone-jwt-secret",
      issuer:
        process.env.DATAZONE_JWT_ISSUER ??
        process.env.ASSERTION_ISSUER ??
        "https://trustedid.netlify.app",
      audience: process.env.DATAZONE_JWT_AUDIENCE ?? "data-zone",
    };
  },
  /**
   * FinProv payment step-up.
   * `http` = remote FinProv engine; `embedded` = temporary local shim behind IFinProvClient.
   */
  get finprov() {
    const mode = (process.env.FINPROV_MODE ?? "embedded") as
      | "unbound"
      | "http"
      | "embedded";
    return {
      mode,
      baseUrl: process.env.FINPROV_BASE_URL ?? "http://localhost:8793",
      apiKey: process.env.FINPROV_API_KEY?.trim() || undefined,
    };
  },
  /** LIDIOS token network (TrustID is IdP; this is outbound health/handshake only). */
  get lidios() {
    const mode = (process.env.LIDIOS_MODE ?? "unbound") as "unbound" | "http";
    return {
      mode,
      baseUrl:
        process.env.LIDIOS_BASE_URL ??
        process.env.LIDIOS_API_PUBLIC_URL ??
        "http://localhost:8794",
    };
  },
  /** Digiconomy commerce RP health/handshake. */
  get digiconomy() {
    const mode = (process.env.DIGICONOMY_MODE ?? "unbound") as "unbound" | "http";
    return {
      mode,
      baseUrl: process.env.DIGICONOMY_BASE_URL ?? "http://localhost:8795",
    };
  },
  /**
   * Platform Jobs Engine — async queue (BullMQ). TrustID enqueues; does not run workers.
   */
  get platformJob() {
    const mode = (process.env.PLATFORM_JOB_MODE ?? "unbound") as "unbound" | "http";
    return {
      mode,
      baseUrl: process.env.PLATFORM_JOB_BASE_URL ?? "http://localhost:4070",
      jwtSecret:
        process.env.PLATFORM_JOB_JWT_SECRET ??
        process.env.TRUST_ID_JWT_SECRET ??
        "dev-trust-id-secret",
      issuer: process.env.PLATFORM_JOB_JWT_ISSUER ?? "lifeos-trust-id",
      audience: process.env.PLATFORM_JOB_JWT_AUDIENCE ?? "platform-jobs-engine",
    };
  },
  /**
   * Master Distributor Engine — tenant/domain provisioning (not identity).
   */
  get masterDistribution() {
    const mode = (process.env.MASTER_DISTRIBUTION_MODE ?? "unbound") as
      | "unbound"
      | "http";
    return {
      mode,
      baseUrl:
        process.env.MASTER_DISTRIBUTION_BASE_URL ?? "http://localhost:3100",
      jwtSecret:
        process.env.MASTER_DISTRIBUTION_JWT_SECRET ??
        process.env.TRUST_ID_JWT_SECRET ??
        "dev-trust-id-secret-change-me",
      issuer: process.env.MASTER_DISTRIBUTION_JWT_ISSUER ?? "lifeos-trust-id",
      audience:
        process.env.MASTER_DISTRIBUTION_JWT_AUDIENCE ??
        "master-distributor-engine",
    };
  },
  /** Temporary: show/log OTP when email/SMS provider is not configured. */
  get otpExposeDebug() {
    return process.env.OTP_EXPOSE_DEBUG === "true" || this.isDev;
  },
  get webauthn() {
    const origins = derivedOrigins();
    const attestationTypeRaw = process.env.WEBAUTHN_ATTESTATION ?? "none";
    const attestationType =
      attestationTypeRaw === "direct" ||
      attestationTypeRaw === "enterprise" ||
      attestationTypeRaw === "none"
        ? attestationTypeRaw
        : attestationTypeRaw === "indirect"
          ? "direct"
          : "none";
    const mode = (process.env.WEBAUTHN_ATTESTATION_MODE ?? "soft") as
      | "off"
      | "soft"
      | "strict";
    const minSecurityLevel = (process.env.WEBAUTHN_MIN_SECURITY_LEVEL ??
      "tee") as "software" | "tee" | "secure_hardware";
    return {
      rpID: derivedRpId(),
      rpName: required("WEBAUTHN_RP_NAME", "TrustID"),
      /** Primary origin (redirects, consent links). */
      origin: origins[0]!,
      /** All accepted browser origins for assertion/attestation verify. */
      origins,
      attestationType: attestationType as "none" | "direct" | "enterprise",
      attestationPolicy: {
        mode: process.env.WEBAUTHN_ATTESTATION_MODE
          ? mode
          : attestationType === "none"
            ? "off"
            : mode,
        attestationType: attestationType as "none" | "direct" | "enterprise",
        minSecurityLevel,
        requireKnownAaguid: process.env.WEBAUTHN_REQUIRE_KNOWN_AAGUID === "true",
      },
    };
  },
  get corsOrigins() {
    const defaults = [
      "http://localhost:5173",
      "http://localhost:5174",
      ...derivedOrigins(),
      siteUrl(),
    ]
      .filter(Boolean)
      .join(",");
    return (process.env.CORS_ORIGINS ?? defaults)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },
  get lifeosRedirectUri() {
    return required(
      "LIFEOS_REDIRECT_URI",
      "http://localhost:5174/callback",
    );
  },
  sessionCookieName: "trustid_session",
  /** Pepper for contact lookup hashes (never log). */
  get piiPepper() {
    const v = process.env.PII_PEPPER;
    if (v) return v;
    if (!this.isDev && process.env.NODE_ENV === "production") {
      throw new Error("Missing env PII_PEPPER");
    }
    return "dev-pii-pepper-change-in-production";
  },
  /** AES-GCM key material (64 hex chars or any passphrase). */
  get sealKey() {
    const v = process.env.SEAL_KEY;
    if (v) return v;
    if (!this.isDev && process.env.NODE_ENV === "production") {
      throw new Error("Missing env SEAL_KEY");
    }
    return "dev-seal-key-change-in-production-please-32b";
  },
  /** Break-glass: allow legacy PII OAuth scopes (email/profile/phone/portrait). */
  get allowLegacyPiiScopes() {
    return process.env.ALLOW_LEGACY_PII_SCOPES === "true";
  },
  /** When false, auth JSON responses omit sessionToken (cookie only). */
  get exposeSessionTokenInBody() {
    return process.env.EXPOSE_SESSION_TOKEN_IN_BODY === "true";
  },
};
