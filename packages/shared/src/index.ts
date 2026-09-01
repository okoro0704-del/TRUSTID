export const SCOPES = {
  OPENID: "openid",
  IDENTITY_BASIC: "identity.basic",
  IDENTITY_PROFILE: "identity.profile",
  IDENTITY_EMAIL: "identity.email",
  IDENTITY_PHONE: "identity.phone",
  IDENTITY_VERIFICATION_STATUS: "identity.verification_status",
  IDENTITY_TRUST_LEVEL: "identity.trust_level",
  IDENTITY_PORTRAIT: "identity.portrait",
  /** Zero-knowledge claim proofs (no raw PII) */
  IDENTITY_ZK_CLAIMS: "identity.zk_claims",
  /** Payment-bound biometric banking step-up (BBS) */
  IDENTITY_BBS_STEP_UP: "identity.bbs_step_up",
  OFFLINE_ACCESS: "offline_access",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export const ALL_SCOPES: Scope[] = Object.values(SCOPES);

export const DEFAULT_APP_SCOPES: Scope[] = [
  SCOPES.OPENID,
  SCOPES.IDENTITY_BASIC,
  SCOPES.IDENTITY_ZK_CLAIMS,
  SCOPES.IDENTITY_TRUST_LEVEL,
  SCOPES.IDENTITY_VERIFICATION_STATUS,
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
  /** ElfCom push dispatched to master device(s) */
  PUSHED: "pushed",
  /** Master device opened the consent notification */
  VIEWED: "viewed",
  APPROVED: "approved",
  TEMPORARY: "temporary",
  DECLINED: "declined",
  EXPIRED: "expired",
} as const;

export type DeviceApprovalStatus =
  (typeof DEVICE_APPROVAL_STATUS)[keyof typeof DEVICE_APPROVAL_STATUS];

/** Non-terminal approval FSM states (guest still waiting). */
export const DEVICE_APPROVAL_ACTIVE_STATUSES = [
  DEVICE_APPROVAL_STATUS.PENDING,
  DEVICE_APPROVAL_STATUS.PUSHED,
  DEVICE_APPROVAL_STATUS.VIEWED,
] as const;

export type DeviceApprovalActiveStatus =
  (typeof DEVICE_APPROVAL_ACTIVE_STATUSES)[number];

/** Terminal approval outcomes. */
export const DEVICE_APPROVAL_TERMINAL_STATUSES = [
  DEVICE_APPROVAL_STATUS.APPROVED,
  DEVICE_APPROVAL_STATUS.TEMPORARY,
  DEVICE_APPROVAL_STATUS.DECLINED,
  DEVICE_APPROVAL_STATUS.EXPIRED,
] as const;

export function isDeviceApprovalActive(status: string): boolean {
  return (DEVICE_APPROVAL_ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function isDeviceApprovalTerminal(status: string): boolean {
  return (DEVICE_APPROVAL_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export const SESSION_KINDS = {
  STANDARD: "standard",
  TEMPORARY: "temporary",
} as const;

export const WEBAUTHN_PURPOSES = {
  REGISTRATION: "registration",
  AUTHENTICATION: "authentication",
  REAUTHENTICATION: "reauthentication",
  DEVICE_ADDITION: "device_addition",
  /** Hardware-backed silent login (Keystore / Keychain attestation). */
  SILENT_AUTHENTICATION: "silent_authentication",
} as const;

export type WebAuthnPurpose =
  (typeof WEBAUTHN_PURPOSES)[keyof typeof WEBAUTHN_PURPOSES];

/** High-assurance / government-style identity verification ceremony status */
export const IDENTITY_VERIFICATION_STATUS = {
  NOT_VERIFIED: "not_verified",
  PENDING: "pending",
  VERIFIED: "verified",
  FAILED: "failed",
  EXPIRED: "expired",
  REVOKED: "revoked",
} as const;

export type IdentityVerificationStatus =
  (typeof IDENTITY_VERIFICATION_STATUS)[keyof typeof IDENTITY_VERIFICATION_STATUS];

/**
 * Authoritative TrustID identity presentation status.
 * Name / email / phone / uploaded photo alone never imply VERIFIED.
 */
export const IDENTITY_STATUS = {
  UNVERIFIED: "unverified",
  PENDING: "pending",
  VERIFIED: "verified",
  REVOKED: "revoked",
  SUSPENDED: "suspended",
} as const;

export type IdentityStatus =
  (typeof IDENTITY_STATUS)[keyof typeof IDENTITY_STATUS];

/** Portrait lifecycle — only VERIFIED is a VERIFIED_IDENTITY_PORTRAIT */
export const PORTRAIT_STATUS = {
  NONE: "none",
  USER_UPLOADED: "user_uploaded",
  PENDING_VERIFICATION: "pending_verification",
  VERIFIED: "verified",
  REJECTED: "rejected",
  REVOKED: "revoked",
} as const;

export type PortraitStatus =
  (typeof PORTRAIT_STATUS)[keyof typeof PORTRAIT_STATUS];

export const VERIFICATION_LEVELS = {
  NONE: "none",
  CONTACT: "contact",
  DEVICE: "device",
  /** Mock / development only — never claim production identity */
  MOCK: "mock",
  DOCUMENT: "document",
  GOVERNMENT: "government",
  HIGH_ASSURANCE: "high_assurance",
} as const;

export const IMPERSONATION_REPORT_TYPES = {
  IDENTITY_IMPERSONATION: "identity_impersonation_report",
  PORTRAIT_MISUSE: "portrait_misuse_report",
  IDENTITY_CONFLICT: "identity_conflict",
} as const;

export const IMPERSONATION_REPORT_STATUS = {
  OPEN: "open",
  UNDER_REVIEW: "under_review",
  RESOLVED: "resolved",
  DISMISSED: "dismissed",
} as const;

export const TRUST_TIERS = {
  TIER_0: 0,
  TIER_1: 1,
  TIER_2: 2,
  TIER_3: 3,
} as const;

export type TrustTier = (typeof TRUST_TIERS)[keyof typeof TRUST_TIERS];

/** Filled stars shown in Trust Center and Life OS — equals trust tier (0–3). */
export const TRUST_STARS_MAX = TRUST_TIERS.TIER_3;

export const TRUST_TIER_LABELS: Record<number, string> = {
  0: "Account created",
  1: "Trusted device",
  2: "Verified identity",
  3: "High assurance",
};

/** Life OS / apps: filled star count is always the trust tier. */
export function trustStarsFromTier(tier: number): {
  stars: number;
  maxStars: number;
} {
  const stars = Math.max(0, Math.min(TRUST_STARS_MAX, Math.floor(tier)));
  return { stars, maxStars: TRUST_STARS_MAX };
}

export const SCOPE_LABELS: Record<string, string> = {
  openid: "Sign-in identity",
  "identity.basic": "Public TrustID identifier",
  "identity.profile": "Basic profile (name)",
  "identity.email": "Email address",
  "identity.phone": "Phone number",
  "identity.verification_status": "Identity verification status",
  "identity.trust_level": "Trust level",
  "identity.zk_claims": "Zero-knowledge trust claims (no raw PII)",
  "identity.bbs_step_up": "Payment-bound biometric banking step-up proofs",
  "identity.portrait": "Verified identity portrait reference",
  offline_access: "Stay signed in (refresh)",
  "wallet.reference": "Wallet reference (future)",
};

export const AUDIT_EVENTS = {
  IDENTITY_CREATED: "identity.created",
  IDENTITY_VERIFIED: "identity.verified",
  IDENTITY_VERIFICATION_STARTED: "identity.verification.started",
  IDENTITY_VERIFICATION_FAILED: "identity.verification.failed",
  IDENTITY_VERIFICATION_REVOKED: "identity.verification.revoked",
  IDENTITY_PROFILE_CHANGED: "identity.profile.changed",
  IDENTITY_SUSPENSION: "identity.suspension",
  IDENTITY_RECOVERY: "identity.recovery",
  IDENTITY_IMPERSONATION_REPORTED: "identity.impersonation.reported",
  PORTRAIT_UPLOADED: "portrait.uploaded",
  PORTRAIT_VERIFIED: "portrait.verified",
  PORTRAIT_REJECTED: "portrait.rejected",
  PORTRAIT_REVOKED: "portrait.revoked",
  PORTRAIT_CHANGED: "portrait.changed",
  ASSERTION_ISSUED: "identity.assertion.issued",
  ASSERTION_VERIFIED: "identity.assertion.verified",
  ASSERTION_REJECTED: "identity.assertion.rejected",
  DEVICE_REGISTERED: "device.registered",
  DEVICE_REVOKED: "device.revoked",
  DEVICE_RENAMED: "device.renamed",
  DEVICE_REGISTRATION_STARTED: "device.registration.started",
  DEVICE_REGISTRATION_COMPLETED: "device.registration.completed",
  DEVICE_REGISTRATION_FAILED: "device.registration.failed",
  DEVICE_AUTHENTICATION_STARTED: "device.authentication.started",
  DEVICE_AUTHENTICATION_COMPLETED: "device.authentication.completed",
  DEVICE_AUTHENTICATION_FAILED: "device.authentication.failed",
  DEVICE_SILENT_AUTH_STARTED: "device.silent_auth.started",
  DEVICE_SILENT_AUTH_COMPLETED: "device.silent_auth.completed",
  DEVICE_SILENT_AUTH_FAILED: "device.silent_auth.failed",
  DEVICE_SILENT_KEY_PAIRED: "device.silent_key.paired",
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
  DEVICE_APPROVAL_PUSHED: "device.approval.pushed",
  DEVICE_APPROVAL_VIEWED: "device.approval.viewed",
  DEVICE_APPROVAL_APPROVED: "device.approval.approved",
  DEVICE_APPROVAL_TEMPORARY: "device.approval.temporary",
  DEVICE_APPROVAL_DECLINED: "device.approval.declined",
  DEVICE_APPROVAL_EXPIRED: "device.approval.expired",
  DEVICE_PROMOTED: "device.promoted",
  DEVICE_PRIMARY_CHANGED: "device.primary_changed",
  DEVICE_SYNC_PREKEYS_PUBLISHED: "device.sync.prekeys_published",
  DEVICE_SYNC_ENVELOPE_QUEUED: "device.sync.envelope_queued",
  DEVICE_SYNC_ENVELOPE_CONSUMED: "device.sync.envelope_consumed",
  RECOVERY_GUARDIAN_CIRCLE_CREATED: "recovery.guardian_circle.created",
  RECOVERY_GUARDIAN_SHARE_CLAIMED: "recovery.guardian_share.claimed",
  RECOVERY_GUARDIAN_THRESHOLD_MET: "recovery.guardian_threshold.met",
  DEVICE_ATTESTATION_ACCEPTED: "device.attestation.accepted",
  DEVICE_ATTESTATION_REJECTED: "device.attestation.rejected",
  DEVICE_ATTESTATION_SOFT_FAIL: "device.attestation.soft_fail",
  BBS_STEP_UP_INITIATED: "bbs.step_up.initiated",
  BBS_STEP_UP_OOB_REQUIRED: "bbs.step_up.oob_required",
  BBS_STEP_UP_APPROVED: "bbs.step_up.approved",
  BBS_STEP_UP_DENIED: "bbs.step_up.denied",
  BBS_STEP_UP_EXPIRED: "bbs.step_up.expired",
  BIOMETRIC_ENROLLED: "biometric.enrolled",
  BIOMETRIC_MATCHED: "biometric.matched",
  BIOMETRIC_MATCH_FAILED: "biometric.match_failed",
  MASTER_DEVICE_REGISTERED: "master_device.registered",
  MASTER_DEVICE_VERIFIED: "master_device.verified",
  MASTER_AUTH_CHALLENGE_ISSUED: "master_auth.challenge_issued",
  MASTER_AUTH_CHALLENGE_APPROVED: "master_auth.challenge_approved",
  MASTER_AUTH_CHALLENGE_DENIED: "master_auth.challenge_denied",
  MASTER_AUTH_CHALLENGE_EXPIRED: "master_auth.challenge_expired",
  AMBIENT_SIGNIN_MATCHED: "ambient.signin.matched",
  AMBIENT_SIGNIN_ENROLLED: "ambient.signin.enrolled",
  AMBIENT_SIGNIN_FAILED: "ambient.signin.failed",
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

/** True only when portrait status is VERIFIED — never for uploads alone. */
export function isVerifiedIdentityPortrait(status: string): boolean {
  return status === PORTRAIT_STATUS.VERIFIED;
}

/** Biometric capture modality for 1:N cloud matching */
export const BIOMETRIC_MODALITIES = {
  FACE: "face",
  FINGERPRINT: "fingerprint",
} as const;

export type BiometricModality =
  (typeof BIOMETRIC_MODALITIES)[keyof typeof BIOMETRIC_MODALITIES];

/** Access tier after 1:N biometric match */
export const TRUST_ID_ACCESS_LEVELS = {
  /** Any device — baseline profile/view/receive */
  UNIVERSAL: "universal",
  /** Bound Master Device — wallet, settings, revocations */
  MASTER: "master",
} as const;

export type TrustIdAccessLevel =
  (typeof TRUST_ID_ACCESS_LEVELS)[keyof typeof TRUST_ID_ACCESS_LEVELS];

export const MASTER_AUTH_CHALLENGE_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  DENIED: "denied",
  EXPIRED: "expired",
} as const;

export type MasterAuthChallengeStatus =
  (typeof MASTER_AUTH_CHALLENGE_STATUS)[keyof typeof MASTER_AUTH_CHALLENGE_STATUS];

/** High-value actions requiring Master Device step-up on secondary terminals */
export const MASTER_STEP_UP_ACTIONS = {
  WALLET_TRANSFER: "wallet_transfer",
  SETTINGS_CHANGE: "settings_change",
  SECURITY_REVOCATION: "security_revocation",
  DEVICE_PROMOTION: "device_promotion",
} as const;

/** Multi-modal fusion: faceScore + fingerprintScore must exceed this */
export const BIOMETRIC_FUSION_THRESHOLD = 1.5;

/** Single-modality fallback when only face OR fingerprint is captured */
export const BIOMETRIC_SINGLE_MODALITY_THRESHOLD = 0.82;
