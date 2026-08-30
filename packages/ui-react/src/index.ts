export {
  TrustIdAuthProvider,
  useTrustIdAuth,
  useAuth,
} from "./context/TrustIdAuthProvider.js";
export type { TrustIdAuthProviderProps } from "./context/TrustIdAuthProvider.js";

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
  TrustIdIdentity,
  TrustIdAuthContextValue,
  RealtimeConnectionState,
  DeviceApprovalEvent,
} from "./types.js";
