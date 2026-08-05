function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function siteUrl(): string | undefined {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
}

function derivedOrigin(): string {
  return process.env.WEBAUTHN_ORIGIN || siteUrl() || "http://localhost:5173";
}

function derivedRpId(): string {
  if (process.env.WEBAUTHN_RP_ID) return process.env.WEBAUTHN_RP_ID;
  try {
    return new URL(derivedOrigin()).hostname;
  } catch {
    return "localhost";
  }
}

/** Lazy config so Netlify can set URL / WEBAUTHN_* before first use. */
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
  get webauthn() {
    return {
      rpID: derivedRpId(),
      rpName: required("WEBAUTHN_RP_NAME", "TrustID"),
      origin: derivedOrigin(),
    };
  },
  get corsOrigins() {
    const origin = derivedOrigin();
    const defaults = [
      "http://localhost:5173",
      "http://localhost:5174",
      origin,
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
