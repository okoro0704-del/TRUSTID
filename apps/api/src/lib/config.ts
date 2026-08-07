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
  /** Temporary: show/log OTP when email/SMS provider is not configured. */
  get otpExposeDebug() {
    return process.env.OTP_EXPOSE_DEBUG === "true" || this.isDev;
  },
  get webauthn() {
    const origins = derivedOrigins();
    return {
      rpID: derivedRpId(),
      rpName: required("WEBAUTHN_RP_NAME", "TrustID"),
      /** Primary origin (redirects, consent links). */
      origin: origins[0]!,
      /** All accepted browser origins for assertion/attestation verify. */
      origins,
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
};
