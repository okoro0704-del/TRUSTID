/**
 * Capacitor WebView entry hook — call after the web bundle loads on native.
 * Keeps @trustid/web free of a device package dependency (avoids build cycles).
 *
 * Usage from a thin native shell script or injected bootstrap:
 *   import { attachNativeAutoLoginToWindow } from '@trustid/device';
 *   attachNativeAutoLoginToWindow();
 */
import { bootstrapNativeAutoLogin } from "./auto-biometric-bootstrap.js";

export function attachNativeAutoLoginToWindow(): void {
  if (typeof window === "undefined") return;
  const w = window as Window & {
    __trustidNativeAutoLogin?: typeof bootstrapNativeAutoLogin;
  };
  w.__trustidNativeAutoLogin = bootstrapNativeAutoLogin;
}

/** Auto-attach when this module is imported on a native Capacitor runtime. */
export function maybeStartNativeAutoLogin(opts: {
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>;
  hasSession: () => boolean | Promise<boolean>;
  onSuccess?: (trustId: string) => void;
}): (() => void) | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cap = (window as any).Capacitor;
    if (!cap?.isNativePlatform?.()) return undefined;
    return bootstrapNativeAutoLogin(opts);
  } catch {
    return undefined;
  }
}
