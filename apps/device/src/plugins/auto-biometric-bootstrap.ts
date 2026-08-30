/**
 * Bootstrap helper for the Capacitor Trust ID app.
 * Call once from the WebView entry after TrustIdAuthProvider mounts.
 */
import {
  bindAutoBiometricLifecycle,
  createAutoBiometricController,
} from "./auto-biometric.js";
import { silentAuthBridge } from "./silent-auth/index.js";

export type BootstrapNativeAutoLoginOptions = {
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>;
  hasSession: () => boolean | Promise<boolean>;
  onSuccess?: (trustId: string) => void;
  onUnpaired?: () => void;
  enabled?: boolean;
};

export function bootstrapNativeAutoLogin(opts: BootstrapNativeAutoLoginOptions) {
  const controller = createAutoBiometricController({
    bridge: silentAuthBridge,
    apiFetch: opts.apiFetch,
    enabled: opts.enabled !== false,
    minSplashMs: 320,
  });

  const unsub = controller.subscribe((status) => {
    if (status === "success") {
      /* identity refresh is caller's responsibility via api session */
    }
    if (status === "unpaired") opts.onUnpaired?.();
  });

  const stopLifecycle = bindAutoBiometricLifecycle(controller, opts.hasSession);

  void controller.start().then((result) => {
    if (result?.trustId) opts.onSuccess?.(result.trustId);
  });

  return () => {
    unsub();
    stopLifecycle();
  };
}
