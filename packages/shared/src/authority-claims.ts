/** Runtime wire contract. Do not coerce malformed or unexpected authority claims. */
export function isAuthorityClaimsShape(p: Record<string, unknown>): boolean {
  const allowed = new Set(["iss", "sub", "aud", "actor", "actions", "resources", "limits", "approval", "grantId", "grantVersion", "oneTime", "jti", "iat", "nbf", "exp", "ownerTrustId"]);
  const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.trim() === v;
  const scope = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(text) && new Set(v).size === v.length;
  if (Object.keys(p).some(k => !allowed.has(k))) return false;
  if (![p.iss, p.sub, p.aud, p.actor, p.grantId, p.jti].every(text)) return false;
  if (!/^(human|app|service|digital_twin|device|business):\S+$/.test(String(p.actor))) return false;
  if (!scope(p.actions) || !scope(p.resources)) return false;
  if (p.approval !== "ALLOW" && p.approval !== "ALLOW_WITH_LIMITS") return false;
  if (typeof p.oneTime !== "boolean" || !Number.isInteger(p.grantVersion) || Number(p.grantVersion) < 1) return false;
  if (![p.iat, p.nbf, p.exp].every(v => typeof v === "number" && Number.isSafeInteger(v))) return false;
  if (Number(p.exp) <= Number(p.iat) || Number(p.nbf) > Number(p.exp) || Number(p.exp) - Number(p.iat) > 300) return false;
  if (p.ownerTrustId !== undefined && !text(p.ownerTrustId)) return false;
  if (!p.limits || typeof p.limits !== "object" || Array.isArray(p.limits)) return false;
  return Object.values(p.limits).every(v => typeof v === "string" || (typeof v === "number" && Number.isFinite(v) && v >= 0));
}
