/**
 * Lab/production boundary. A lab result is evaluation evidence only.
 */
export const LAB_RESULT_KIND = "EVALUATION_RESULT" as const;

export const LAB_AUTHORITY_BOUNDARY = {
  mintsSession: false,
  createsTrustId: false,
  grantsOwnerAuthority: false,
  grantsAdminAuthority: false,
  grantsFinancialAuthority: false,
  invokesDigiAuthority: false,
  mutatesProductionBiometrics: false,
  changesProductionThreshold: false,
} as const;

const FORBIDDEN_KEYS = new Set(
  [
    "sessionToken",
    "token",
    "accessToken",
    "refreshToken",
    "idToken",
    "trustId",
    "userId",
    "ownerId",
    "grantId",
    "capability",
    "authorityToken",
    "setCookie",
    "privateKey",
  ].map((k) => k.toLowerCase()),
);

/** Throws if a lab response carries anything shaped like identity or authority. */
export function assertLabResponseIsolation(value: unknown, path = "$"): void {
  if (value == null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertLabResponseIsolation(v, `${path}[${i}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new Error(`Lab response must not contain identity/authority field ${path}.${key}`);
    }
    assertLabResponseIsolation(child, `${path}.${key}`);
  }
}
