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

export const DEVICE_STATUS = {
  ACTIVE: "active",
  REVOKED: "revoked",
  /** @deprecated Prefer ACTIVE — retained for read compatibility */
  TRUSTED: "trusted",
} as const;

export function isDeviceCredentialActive(status: string): boolean {
  return status === DEVICE_STATUS.ACTIVE || status === DEVICE_STATUS.TRUSTED;
}

/** Device trust classification within an account */
export const DEVICE_TRUST_LEVELS = {
  PRIMARY: "primary",
  STANDARD: "standard",
  TEMPORARY: "temporary",
} as const;

export type DeviceTrustLevel =
  (typeof DEVICE_TRUST_LEVELS)[keyof typeof DEVICE_TRUST_LEVELS];

export const DEVICE_APPROVAL_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  TEMPORARY: "temporary",
  DECLINED: "declined",
  EXPIRED: "expired",
} as const;

export type DeviceApprovalStatus =
  (typeof DEVICE_APPROVAL_STATUS)[keyof typeof DEVICE_APPROVAL_STATUS];

export const SESSION_KINDS = {
  STANDARD: "standard",
  TEMPORARY: "temporary",
} as const;

export const WEBAUTHN_PURPOSES = {
  REGISTRATION: "registration",
  AUTHENTICATION: "authentication",
  REAUTHENTICATION: "reauthentication",
  DEVICE_ADDITION: "device_addition",
} as const;

export type WebAuthnPurpose =
  (typeof WEBAUTHN_PURPOSES)[keyof typeof WEBAUTHN_PURPOSES];

export const IDENTITY_VERIFICATION_STATUS = {
  NOT_VERIFIED: "not_verified",
  PENDING: "pending",
  VERIFIED: "verified",
  FAILED: "failed",
} as const;

export const TRUST_TIERS = {
  TIER_0: 0,
  TIER_1: 1,
  TIER_2: 2,
  TIER_3: 3,
} as const;

export type TrustTier = (typeof TRUST_TIERS)[keyof typeof TRUST_TIERS];

export const TRUST_TIER_LABELS: Record<number, string> = {
  0: "Account created",
  1: "Trusted device",
  2: "Verified identity",
  3: "High assurance",
};

export const SCOPE_LABELS: Record<string, string> = {
  openid: "Sign-in identity",
  "identity.basic": "Public TrustID identifier",
  "identity.profile": "Basic profile (name)",
  "identity.email": "Email address",
  "identity.phone": "Phone number",
  offline_access: "Stay signed in (refresh)",
  "wallet.reference": "Wallet reference (future)",
  "identity.verification_status": "Identity verification status",
  "identity.trust_level": "Trust level",
};

export const AUDIT_EVENTS = {
  IDENTITY_CREATED: "identity.created",
  IDENTITY_VERIFIED: "identity.verified",
  DEVICE_REGISTERED: "device.registered",
  DEVICE_REVOKED: "device.revoked",
  DEVICE_RENAMED: "device.renamed",
  DEVICE_REGISTRATION_STARTED: "device.registration.started",
  DEVICE_REGISTRATION_COMPLETED: "device.registration.completed",
  DEVICE_REGISTRATION_FAILED: "device.registration.failed",
  DEVICE_AUTHENTICATION_STARTED: "device.authentication.started",
  DEVICE_AUTHENTICATION_COMPLETED: "device.authentication.completed",
  DEVICE_AUTHENTICATION_FAILED: "device.authentication.failed",
  DEVICE_SIGNATURE_COUNTER_WARNING: "device.signature_counter.warning",
  DEVICE_ENROLLMENT_CREATED: "device.enrollment.created",
  DEVICE_ENROLLMENT_APPROVED: "device.enrollment.approved",
  DEVICE_ENROLLMENT_COMPLETED: "device.enrollment.completed",
  PASSKEY_RENAMED: "passkey.renamed",
  PASSKEY_REMOVED: "passkey.removed",
  SESSION_CREATED: "session.created",
  SESSION_REVOKED: "session.revoked",
  APPLICATION_AUTHORIZED: "application.authorized",
  APPLICATION_REVOKED: "application.revoked",
  PERMISSION_GRANTED: "permission.granted",
  PERMISSION_REVOKED: "permission.revoked",
  SECURITY_SETTINGS_CHANGED: "security.settings.changed",
  RECOVERY_STARTED: "recovery.started",
  RECOVERY_COMPLETED: "recovery.completed",
  PAIRING_REQUESTED: "device.pairing_requested",
  PAIRING_APPROVED: "device.pairing_approved",
  PAIRING_REJECTED: "device.pairing_rejected",
  DEVICE_APPROVAL_REQUESTED: "device.approval.requested",
  DEVICE_APPROVAL_APPROVED: "device.approval.approved",
  DEVICE_APPROVAL_TEMPORARY: "device.approval.temporary",
  DEVICE_APPROVAL_DECLINED: "device.approval.declined",
  DEVICE_APPROVAL_EXPIRED: "device.approval.expired",
  DEVICE_PROMOTED: "device.promoted",
  DEVICE_PRIMARY_CHANGED: "device.primary_changed",
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
