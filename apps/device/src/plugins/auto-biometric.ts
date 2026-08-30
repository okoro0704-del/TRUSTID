/**
 * Native Capacitor auto-biometric login on launch / resume.
 * Shows a splash phase while Keystore/Keychain silent auth completes.
 */

import type { SilentAuthBridge, SilentAssertResult } from "@trustid/device-security";
import { runNativeSilentLogin } from "@trustid/device-security";

export type AutoBiometricStatus =
  | "idle"
  | "splash"
  | "prompting"
  | "success"
  | "unpaired"
  | "error"
  | "skipped";

export type AutoBiometricController = {
  getStatus(): AutoBiometricStatus;
  getError(): string | null;
  /** Start auto prompt (idempotent per cold start unless force). */
  start(options?: { force?: boolean; reason?: string }): Promise<SilentAssertResult | null>;
  /** Re-run on app resume when session is gone. */
  onAppResume(hasSession: boolean): Promise<SilentAssertResult | null>;
  subscribe(listener: (status: AutoBiometricStatus) => void): () => void;
};

export type CreateAutoBiometricOptions = {
  bridge: SilentAuthBridge;
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>;
  /** Minimum splash visibility to avoid flicker (ms). Default 280. */
  minSplashMs?: number;
  /** Skip auto prompt when false. */
  enabled?: boolean;
};

/**
 * Creates a controller that:
 * 1. Enters splash immediately
 * 2. Triggers hardware biometric + silent-assert
 * 3. Resolves with session result or unpaired/error
 */
export function createAutoBiometricController(
  opts: CreateAutoBiometricOptions,
): AutoBiometricController {
  const minSplashMs = opts.minSplashMs ?? 280;
  let status: AutoBiometricStatus = "idle";
  let error: string | null = null;
  let started = false;
  let inflight: Promise<SilentAssertResult | null> | null = null;
  const listeners = new Set<(s: AutoBiometricStatus) => void>();

  function setStatus(next: AutoBiometricStatus) {
    status = next;
    for (const l of listeners) l(next);
  }

  async function start(options?: {
    force?: boolean;
    reason?: string;
  }): Promise<SilentAssertResult | null> {
    if (opts.enabled === false) {
      setStatus("skipped");
      return null;
    }
    if (started && !options?.force) {
      return inflight;
    }
    started = true;
    setStatus("splash");
    error = null;

    const splashStarted = Date.now();
    inflight = (async () => {
      try {
        // Brief splash before OS sheet to avoid flicker into empty WebView
        const wait = Math.max(0, minSplashMs - (Date.now() - splashStarted));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        setStatus("prompting");
        const result = await runNativeSilentLogin(
          opts.bridge,
          { fetch: opts.apiFetch },
          { reason: options?.reason ?? "Sign in to Trust ID" },
        );
        setStatus("success");
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        error = msg;
        if (/unpaired|device_unpaired/i.test(msg)) {
          setStatus("unpaired");
        } else if (/cancel|denied|abort/i.test(msg)) {
          setStatus("skipped");
          error = null;
        } else {
          setStatus("error");
        }
        return null;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  async function onAppResume(hasSession: boolean) {
    if (hasSession) {
      setStatus("success");
      return null;
    }
    return start({ force: true, reason: "Welcome back — unlock Trust ID" });
  }

  return {
    getStatus: () => status,
    getError: () => error,
    start,
    onAppResume,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Attach document visibility / focus listeners for resume auto-prompt.
 * Call from the Capacitor WebView bootstrap once.
 */
export function bindAutoBiometricLifecycle(
  controller: AutoBiometricController,
  hasSession: () => boolean | Promise<boolean>,
): () => void {
  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      void Promise.resolve(hasSession()).then((ok) => {
        if (!ok) void controller.onAppResume(false);
      });
    }
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisible);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onVisible);
  }

  // Cold start
  void controller.start();

  return () => {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisible);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", onVisible);
    }
  };
}
