export const SCOPES = {
  OPENID: "openid",
  IDENTITY_BASIC: "identity.basic",
  IDENTITY_PROFILE: "identity.profile",
  IDENTITY_EMAIL: "identity.email",
  IDENTITY_PHONE: "identity.phone",
  OFFLINE_ACCESS: "offline_access",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export const ALL_SCOPES: Scope[] = Object.values(SCOPES);

export const DEFAULT_APP_SCOPES: Scope[] = [
  SCOPES.OPENID,
  SCOPES.IDENTITY_BASIC,
  SCOPES.IDENTITY_PROFILE,
  SCOPES.IDENTITY_EMAIL,
];

export const AUDIT_EVENTS = {
  IDENTITY_CREATED: "identity.created",
  IDENTITY_VERIFIED: "identity.verified",
  DEVICE_REGISTERED: "device.registered",
  DEVICE_REVOKED: "device.revoked",
  DEVICE_RENAMED: "device.renamed",
  SESSION_CREATED: "session.created",
  SESSION_REVOKED: "session.revoked",
  APPLICATION_AUTHORIZED: "application.authorized",
  APPLICATION_REVOKED: "application.revoked",
  PERMISSION_GRANTED: "permission.granted",
  PERMISSION_REVOKED: "permission.revoked",
  RECOVERY_STARTED: "recovery.started",
  RECOVERY_COMPLETED: "recovery.completed",
  PAIRING_REQUESTED: "device.pairing_requested",
  PAIRING_APPROVED: "device.pairing_approved",
  PAIRING_REJECTED: "device.pairing_rejected",
} as const;

export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

/** Crockford Base32 alphabet (no I, L, O, U). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateTrustId(randomBytes: Uint8Array): string {
  if (randomBytes.length < 5) {
    throw new Error("Need at least 5 random bytes for TrustID");
  }
  let value = 0n;
  for (let i = 0; i < 5; i++) {
    value = (value << 8n) | BigInt(randomBytes[i]!);
  }
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return `TD-${out}`;
}

export function isValidTrustId(id: string): boolean {
  return /^TD-[0-9A-HJKMNP-TV-Z]{8}$/.test(id);
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-4)}`;
}
