import type { ReactNode } from "react";
import {
  useAmbientTrustIdAuth,
  type UseAmbientTrustIdAuthOptions,
} from "../hooks/useAmbientTrustIdAuth.js";

export type TrustIdAmbientAuthProviderProps = UseAmbientTrustIdAuthOptions & {
  children: ReactNode;
  brand?: string;
};

function AmbientSplash({
  brand,
  msg,
  children,
  spinning = false,
}: {
  brand: string;
  msg: string;
  children?: ReactNode;
  /** Only show the search ring while actively matching */
  spinning?: boolean;
}) {
  return (
    <div className="tid-ambient-splash" role="status" aria-live="polite">
      <div className="tid-ambient-splash-panel">
        <div className="tid-silent-splash-mark" aria-hidden="true" />
        <h1 className="tid-silent-splash-brand">{brand}</h1>
        <p className="tid-ambient-splash-msg">{msg}</p>
        {children}
        {spinning && !children ? (
          <div className="tid-silent-splash-ring" aria-hidden="true" />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Global identity-first auth shell — lookup before any enroll write.
 * NO_MATCH stops the scan; registration requires an explicit user action.
 */
export function TrustIdAmbientAuthProvider({
  children,
  brand = "TrustID",
  ...options
}: TrustIdAmbientAuthProviderProps) {
  const {
    phase,
    error,
    fingerprintBusy,
    retry,
    confirmSwitchAccount,
    confirmCreateAccount,
    continueAfterDeviceSaved,
    confirmFingerprintBackup,
    skipFingerprintBackup,
    useFingerprintLogin,
    continueAfterApproval,
    lastResult,
    previousTrustId,
  } = useAmbientTrustIdAuth(options);

  if (phase === "AUTHENTICATED") {
    return <>{children}</>;
  }

  if (phase === "NO_MATCH" || phase === "OFFER_CREATE") {
    return (
      <AmbientSplash brand={brand} msg="No Trust ID found">
        <p className="tid-ambient-splash-msg" style={{ marginTop: "0.65rem" }}>
          We couldn&apos;t find a Trust ID registered to this face.
        </p>
        {error ? (
          <p
            className="tid-ambient-splash-msg"
            style={{ marginTop: "0.65rem", color: "#fbbf24" }}
          >
            {error}
          </p>
        ) : null}
        <div
          className="tid-ambient-choice-row"
          role="group"
          aria-label="Choose next step"
        >
          <div className="tid-ambient-choice-card">
            <p className="tid-ambient-choice-label">Already have an account</p>
            <button
              type="button"
              className="tid-btn"
              onClick={retry}
              disabled={fingerprintBusy}
            >
              Retry Face Scan
            </button>
            <button
              type="button"
              className="tid-btn tid-btn-ghost"
              onClick={useFingerprintLogin}
              disabled={fingerprintBusy}
            >
              {fingerprintBusy ? "Verifying…" : "Use Fingerprint"}
            </button>
          </div>
          <div className="tid-ambient-choice-card tid-ambient-choice-card-primary">
            <p className="tid-ambient-choice-label">New here</p>
            <button
              type="button"
              className="tid-btn tid-btn-primary"
              onClick={confirmCreateAccount}
              disabled={fingerprintBusy}
            >
              Register Trust ID
            </button>
          </div>
        </div>
      </AmbientSplash>
    );
  }

  if (phase === "FACE_SAVED" || phase === "DEVICE_SAVED") {
    return (
      <AmbientSplash brand={brand} msg="Face saved successfully">
        <div className="tid-ambient-saved-mark" aria-hidden="true">
          ✓
        </div>
        <p className="tid-ambient-splash-msg">
          Your Trust ID face identity has been saved to this device
          {lastResult?.trustId ? ` (${lastResult.trustId})` : ""}.
        </p>
        <p className="tid-ambient-splash-msg" style={{ marginTop: "0.75rem" }}>
          This phone is your Master Device. Next, add a fingerprint backup.
        </p>
        <div className="tid-ambient-splash-actions">
          <button
            type="button"
            className="tid-btn tid-btn-primary"
            onClick={continueAfterDeviceSaved}
          >
            Continue
          </button>
        </div>
      </AmbientSplash>
    );
  }

  if (phase === "OFFER_FINGERPRINT") {
    return (
      <AmbientSplash brand={brand} msg="Set up fingerprint backup">
        <p className="tid-ambient-splash-msg" style={{ marginTop: "0.75rem" }}>
          Your face is now registered. Add your fingerprint as a backup for this
          device.
        </p>
        <div className="tid-ambient-splash-actions">
          <button
            type="button"
            className="tid-btn tid-btn-primary"
            onClick={confirmFingerprintBackup}
          >
            Register Fingerprint
          </button>
          <button
            type="button"
            className="tid-btn tid-btn-ghost"
            onClick={skipFingerprintBackup}
          >
            Finish Later
          </button>
        </div>
      </AmbientSplash>
    );
  }

  if (phase === "FINGERPRINT_FAILED") {
    return (
      <AmbientSplash
        brand={brand}
        msg="Your face was saved, but fingerprint backup wasn't completed."
      >
        {error ? (
          <p
            className="tid-ambient-splash-msg"
            style={{ marginTop: "0.65rem", color: "#fbbf24" }}
          >
            {error}
          </p>
        ) : null}
        <div className="tid-ambient-splash-actions">
          <button
            type="button"
            className="tid-btn tid-btn-primary"
            onClick={confirmFingerprintBackup}
          >
            Try Fingerprint Again
          </button>
          <button
            type="button"
            className="tid-btn tid-btn-ghost"
            onClick={skipFingerprintBackup}
          >
            Finish Later
          </button>
        </div>
      </AmbientSplash>
    );
  }

  if (phase === "SWITCH_ACCOUNT") {
    return (
      <div className="tid-ambient-splash" role="status">
        <div className="tid-ambient-splash-panel">
          <h1 className="tid-silent-splash-brand">{brand}</h1>
          <p className="tid-ambient-splash-msg">
            Not the previous Trust ID
            {previousTrustId ? ` (${previousTrustId})` : ""} that signed in on
            this device.
          </p>
          <p className="tid-ambient-splash-msg">
            Continue as{" "}
            <strong>{lastResult?.trustId ?? "another account"}</strong>?
          </p>
          <div className="tid-ambient-splash-actions">
            <button
              type="button"
              className="tid-btn tid-btn-primary"
              onClick={confirmSwitchAccount}
            >
              Continue as this face
            </button>
            <button type="button" className="tid-btn" onClick={retry}>
              Retry Face Scan
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "NEEDS_APPROVAL") {
    return (
      <div className="tid-ambient-splash" role="status">
        <div className="tid-ambient-splash-panel">
          <h1 className="tid-silent-splash-brand">{brand}</h1>
          <p className="tid-ambient-splash-msg">
            Identity matched
            {lastResult?.trustId ? ` (${lastResult.trustId})` : ""}. Waiting for
            your Master Device to allow this terminal…
          </p>
          <p className="tid-ambient-splash-msg">
            Approve the request on your primary phone, then tap Continue.
          </p>
          <div className="tid-ambient-splash-actions">
            <button
              type="button"
              className="tid-btn tid-btn-primary"
              onClick={continueAfterApproval}
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "ERROR") {
    const serviceDown = /BIOMETRIC_SERVICE_UNAVAILABLE|BIOMETRIC_MODEL_UNAVAILABLE/i.test(
      error ?? "",
    );
    return (
      <AmbientSplash brand={brand} msg={error ?? "Verification paused"}>
        <div
          className="tid-ambient-choice-row"
          role="group"
          aria-label="Choose next step"
        >
          <div className="tid-ambient-choice-card">
            <p className="tid-ambient-choice-label">Try again</p>
            <button type="button" className="tid-btn" onClick={retry}>
              Retry Face Scan
            </button>
            <button
              type="button"
              className="tid-btn tid-btn-ghost"
              onClick={useFingerprintLogin}
              disabled={fingerprintBusy}
            >
              {fingerprintBusy ? "Verifying…" : "Use Fingerprint"}
            </button>
          </div>
          {!serviceDown ? (
            <div className="tid-ambient-choice-card tid-ambient-choice-card-primary">
              <p className="tid-ambient-choice-label">New here</p>
              <button
                type="button"
                className="tid-btn tid-btn-primary"
                onClick={confirmCreateAccount}
              >
                Register Trust ID
              </button>
            </div>
          ) : (
            <div className="tid-ambient-choice-card">
              <p className="tid-ambient-choice-label">Service issue</p>
              <p className="tid-ambient-splash-msg" style={{ fontSize: "0.9rem" }}>
                Registration is not offered while the biometric service is
                unavailable — a service failure is not proof that you have no
                Trust ID.
              </p>
            </div>
          )}
        </div>
      </AmbientSplash>
    );
  }

  const spinning =
    phase === "CHECKING" ||
    phase === "PROMPTING" ||
    phase === "ENROLLING" ||
    phase === "SAVING_FINGERPRINT";

  const msg =
    phase === "ENROLLING"
      ? "Register your face — capturing enrollment samples…"
      : phase === "SAVING_FINGERPRINT"
        ? "Register fingerprint backup…"
        : "Looking for your Trust ID…";

  return <AmbientSplash brand={brand} msg={msg} spinning={spinning} />;
}
