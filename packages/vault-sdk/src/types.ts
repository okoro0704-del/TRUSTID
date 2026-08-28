/** Sovereign Vault & Privacy Shield — shared types. */

export type RouteSensitivity = "low" | "medium" | "high" | "critical";

export type ProtectedRoute = {
  path: string;
  sensitivity: RouteSensitivity;
  hidden?: boolean;
};

export type ProtectedAppEntry = {
  appId: string;
  packageId?: string;
  displayName: string;
  hidden?: boolean;
  addedAt: string;
};

/** App Lock Registry — protected apps, hidden shortcuts, media routes. */
export type AppLockConfig = {
  enabled: boolean;
  protectedAppIds: string[];
  hiddenAppShortcuts: string[];
  protectedRoutes: ProtectedRoute[];
  protectedApps: ProtectedAppEntry[];
  duressEnabled: boolean;
  /** Post-auth grace before re-challenge (ms). */
  postAuthGraceMs: number;
  allowDeviceCredential: boolean;
  biometricStrongOnly: boolean;
};

export const DEFAULT_APP_LOCK_CONFIG: AppLockConfig = {
  enabled: false,
  protectedAppIds: [],
  hiddenAppShortcuts: [],
  protectedRoutes: [],
  protectedApps: [],
  duressEnabled: false,
  postAuthGraceMs: 8_000,
  allowDeviceCredential: false,
  biometricStrongOnly: true,
};

export type StepUpPolicy = {
  /** Re-auth when session older than this (ms). */
  maxSessionAgeMs: number;
  /** Minimum risk score [0–100] to force step-up. */
  riskThreshold: number;
  /** Routes at or above this sensitivity require fresh biometric. */
  minSensitivityForStepUp: RouteSensitivity;
};

export const DEFAULT_STEP_UP_POLICY: StepUpPolicy = {
  maxSessionAgeMs: 15 * 60_000,
  riskThreshold: 60,
  minSensitivityForStepUp: "medium",
};

export type RiskContext = {
  sessionAgeMs: number;
  routeSensitivity: RouteSensitivity;
  orientationChanged?: boolean;
  unrecognizedDevice?: boolean;
  anomalyScore?: number;
  action?: "view_encrypted_video" | "unlock_hidden_app" | "sensitive_transaction" | "route_access";
};

export type BiometricAuthResult = {
  ok: boolean;
  method: string;
  /** Set when native layer detects configured duress biometric. */
  duress?: boolean;
};

export type EsfsManifest = {
  version: 1;
  assetId: string;
  mimeType: string;
  displayName: string;
  contentHash: string;
  chunkSize: number;
  chunkCount: number;
  createdAt: string;
};

export type EmergencyAlertPayload = {
  type: "vault_duress";
  correlationId: string;
  at: string;
  note: string;
};

export type ElfComEmergencyBridge = {
  dispatchEmergencyAlert(payload: EmergencyAlertPayload): Promise<{ ok: boolean }>;
};

export type NativeDakBridge = {
  /** True when DAK lives in Secure Enclave / StrongBox. */
  hardwareBacked: boolean;
  /** Unlock DAK after OS biometric — returns opaque session handle. */
  unlockDakAfterBiometric(input: {
    reason: string;
    strongOnly: boolean;
    allowDeviceCredential: boolean;
  }): Promise<{ sessionHandle: string; duress?: boolean }>;
  /** Derive chunk CDK inside secure module; returns base64 raw key bytes (never persisted by JS on native). */
  deriveCdk(input: {
    sessionHandle: string;
    assetId: string;
    chunkIndex: number;
  }): Promise<{ cdkBase64: string }>;
  lockDak(): Promise<void>;
};
