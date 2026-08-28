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
} from "./components/TrustIdLoginButton.js";
export type {
  TrustIdLoginButtonProps,
  AuthOptions,
  LoginHints,
} from "./components/TrustIdLoginButton.js";

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
