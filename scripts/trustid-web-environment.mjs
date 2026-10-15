/**
 * Build-time environment of the TrustID web app: "production", "staging" or "development".
 *
 * Compiled into the bundle as __TRUSTID_WEB_ENV__ (apps/web/vite.config.ts), so code paths that may
 * only exist in production (production ElfCom, the production APK download) are removed from every
 * other build by the minifier rather than skipped at runtime.
 *
 *   VITE_TRUSTID_DEPLOY_ENV set          → that value (must be production | staging | development)
 *   Vite mode "device" (Capacitor bundle) → production (the bundled device build is the production app)
 *   TRUSTID_DEPLOY_ENV=staging            → staging (the staging Netlify site)
 *   SITE_NAME=trustedid + CONTEXT=production (Netlify production site) → production
 *   anything else (deploy previews, branch deploys, local builds) → development
 */
export const WEB_ENVIRONMENTS = ["production", "staging", "development"];

export function resolveWebEnvironment(env, mode) {
  const explicit = String(env.VITE_TRUSTID_DEPLOY_ENV ?? "").trim();
  if (explicit) {
    if (!WEB_ENVIRONMENTS.includes(explicit)) {
      throw new Error(`VITE_TRUSTID_DEPLOY_ENV must be one of ${WEB_ENVIRONMENTS.join(", ")}, not "${explicit}"`);
    }
    return explicit;
  }
  if (mode === "device") return "production";
  const deployEnv = String(env.TRUSTID_DEPLOY_ENV ?? "").trim();
  if (deployEnv === "staging") return "staging";
  if (env.SITE_NAME === "trustedid" && env.CONTEXT === "production") return "production";
  return "development";
}
