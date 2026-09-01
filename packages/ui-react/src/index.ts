export {
  TrustIdAuthProvider,
  useTrustIdAuth as useTrustIdSession,
  useAuth,
} from "./context/TrustIdAuthProvider.js";
export type { TrustIdAuthProviderProps } from "./context/TrustIdAuthProvider.js";

/** Smart auth state machine (probe → biometric → create account). */
export {
  useTrustIdAuth,
  type TrustIdAuthPhase,
  type UseTrustIdAuthOptions,
  type UseTrustIdAuthResult,
} from "./hooks/useTrustIdAuth.js";

export {
  TrustIdLoginButton,
  createLoginOptionsCache,
  runPasskeyLogin,
  runSilentPasskeyLogin,
} from "./components/TrustIdLoginButton.js";
export type {
  TrustIdLoginButtonProps,
  AuthOptions,
  LoginHints,
} from "./components/TrustIdLoginButton.js";

export { AutoAuthGuard } from "./components/AutoAuthGuard.js";
export type { AutoAuthGuardProps } from "./components/AutoAuthGuard.js";

export { TrustIdSmartAuthGuard } from "./components/TrustIdSmartAuthGuard.js";
export type { TrustIdSmartAuthGuardProps } from "./components/TrustIdSmartAuthGuard.js";

export { TrustIdAmbientAuthProvider } from "./components/TrustIdAmbientAuthProvider.js";
export type { TrustIdAmbientAuthProviderProps } from "./components/TrustIdAmbientAuthProvider.js";

export {
  useAmbientTrustIdAuth,
  type AmbientAuthPhase,
  type UseAmbientTrustIdAuthOptions,
  type UseAmbientTrustIdAuthResult,
} from "./hooks/useAmbientTrustIdAuth.js";

export { CreateTrustIdAccount } from "./components/CreateTrustIdAccount.js";

export { EcosystemAutoLogin } from "./components/EcosystemAutoLogin.js";
export type { EcosystemAutoLoginProps } from "./components/EcosystemAutoLogin.js";

export { useSilentAutoLogin } from "./hooks/useSilentAutoLogin.js";
export type {
  UseSilentAutoLoginOptions,
  UseSilentAutoLoginResult,
  SilentAutoLoginStatus,
} from "./hooks/useSilentAutoLogin.js";

export {
  executeSilentWebLogin,
  executeSilentWebLoginOnce,
  runImmediateSilentPasskey,
  fetchSilentLoginOptions,
  postSilentWebAuthnAssert,
  clearSilentAutoLoginAttempt,
  clearStaleAuthCaches,
  resetSilentWebLoginInflight,
  withWebAuthnTimeout,
  WEBAUTHN_PROBE_TIMEOUT_MS,
} from "./lib/silentAuth.js";
export type { SilentAssertIdentityResult } from "./lib/silentAuth.js";

export { VaultProtectedMediaViewer } from "./components/VaultProtectedMediaViewer.js";
export type { VaultProtectedMediaViewerProps } from "./components/VaultProtectedMediaViewer.js";

export { AppLockGuardOverlay } from "./components/AppLockGuardOverlay.js";
export type { AppLockGuardOverlayProps } from "./components/AppLockGuardOverlay.js";

export { DeviceApprovalModal } from "./components/DeviceApprovalModal.js";
export type { DeviceApprovalModalProps } from "./components/DeviceApprovalModal.js";

export {
  createTrustIdApiClient,
  resolveRealtimeUrl,
  TrustIdApiError,
} from "./api/client.js";
export type { TrustIdApiClient, TrustIdApiClientOptions } from "./api/client.js";

export type {
  BiometricPayload,
  ScanAndIdentifyResult,
  TrustIdSdkOptions,
  VerifyMasterDeviceResult,
  AmbientAuthenticateOptions,
  AmbientSignInResult,
  CaptureHandlers,
  MultiModalBiometricPayload,
} from "@trustid/sdk";
export {
  TrustIdSdk,
  createTrustIdSdk,
  ambientAuthenticate,
  captureMultiModal,
  BIOMETRIC_MODALITIES,
  TRUST_ID_ACCESS_LEVELS,
} from "@trustid/sdk";

export type {
  TrustIdIdentity,
  TrustIdAuthContextValue,
  RealtimeConnectionState,
  DeviceApprovalEvent,
} from "./types.js";
