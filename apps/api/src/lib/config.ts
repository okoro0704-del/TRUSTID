function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  nodeEnv: process.env.NODE_ENV ?? "development",
  isDev: (process.env.NODE_ENV ?? "development") !== "production",
  cookieSecret: required("COOKIE_SECRET", "dev-cookie-secret-change-in-production"),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 168),
  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES ?? 10),
  webauthn: {
    rpID: required("WEBAUTHN_RP_ID", "localhost"),
    rpName: required("WEBAUTHN_RP_NAME", "TrustID"),
    origin: required("WEBAUTHN_ORIGIN", "http://localhost:5173"),
  },
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:5174")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  lifeosRedirectUri: required(
    "LIFEOS_REDIRECT_URI",
    "http://localhost:5174/callback",
  ),
  sessionCookieName: "trustid_session",
};
