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

  if (phase === "OFFER_CREATE") {
    const canCreate = Boolean(
      // Face payload is kept on NOT_FOUND; create needs it.
      true,
    );
    return (
      <AmbientSplash brand={brand} msg="No matching face — search stopped.">
        {error ? (
          <p className="tid-ambient-splash-msg" style={{ marginTop: "0.65rem", color: "#fbbf24" }}>
            {error}
          </p>
        ) : (
          <p className="tid-ambient-splash-msg" style={{ marginTop: "0.65rem" }}>
            Already have an account? Retry face or unlock with fingerprint.
            New here? Create a Trust ID on this Master Device.
          </p>
        )}
        <div className="tid-ambient-choice-row" role="group" aria-label="Choose next step">
          <div className="tid-ambient-choice-card">
            <p className="tid-ambient-choice-label">Already have an account</p>
            <button
              type="button"
              className="tid-btn"
              onClick={retry}
              disabled={fingerprintBusy}
            >
              Retry face
            </button>
            <button
              type="button"
              className="tid-btn tid-btn-ghost"
              onClick={useFingerprintLogin}
              disabled={fingerprintBusy}
            >
              {fingerprintBusy ? "Verifying passkey…" : "Use passkey"}
            </button>
          </div>
          <div className="tid-ambient-choice-card tid-ambient-choice-card-primary">
            <p className="tid-ambient-choice-label">New user</p>
            <button
              type="button"
              className="tid-btn tid-btn-primary"
              onClick={confirmCreateAccount}
              disabled={fingerprintBusy || !canCreate}
            >
              Create Trust ID
            </button>
          </div>
        </div>
      </AmbientSplash>
    );
  }

  if (phase === "DEVICE_SAVED") {
    return (
      <AmbientSplash
        brand={brand}
        msg={`Trust ID ${lastResult?.trustId ?? ""} is saved on this device.`}
      >
        <div className="tid-ambient-saved-mark" aria-hidden="true">
          ?
        </div>
        <p className="tid-ambient-splash-msg">
          This phone is your Master Device. Approvals and sign-in start here.
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
      <AmbientSplash
        brand={brand}
        msg="Add a fingerprint as an alternative sign-in."
      >
        <p className="tid-ambient-splash-msg" style={{ marginTop: "0.75rem" }}>
          If face match fails later, Trust ID can unlock with your fingerprint.
        </p>
        <div className="tid-ambient-splash-actions">
          <button
            type="button"
            className="tid-btn tid-btn-primary"
            onClick={confirmFingerprintBackup}
          >
            Add fingerprint
          </button>
          <button
            type="button"
            className="tid-btn tid-btn-ghost"
            onClick={skipFingerprintBackup}
          >
            Skip for now
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
              Retry face
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
    return (
      <AmbientSplash brand={brand} msg={error ?? "Verification paused"}>
        <div className="tid-ambient-choice-row" role="group" aria-label="Choose next step">
          <div className="tid-ambient-choice-card">
            <p className="tid-ambient-choice-label">Already have an account</p>
            <button type="button" className="tid-btn" onClick={retry}>
              Retry face
            </button>
            <button
              type="button"
              className="tid-btn tid-btn-ghost"
              onClick={useFingerprintLogin}
              disabled={fingerprintBusy}
            >
              {fingerprintBusy ? "Verifying passkey…" : "Use passkey"}
            </button>
          </div>
          <div className="tid-ambient-choice-card tid-ambient-choice-card-primary">
            <p className="tid-ambient-choice-label">New user</p>
            <button
              type="button"
              className="tid-btn tid-btn-primary"
              onClick={confirmCreateAccount}
            >
              Create Trust ID
            </button>
          </div>
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
      ? "Creating your Trust ID and binding this Master Device…"
      : phase === "SAVING_FINGERPRINT"
        ? "Scan your fingerprint to save an alternative unlock…"
        : "Looking at your face and matching the Trust ID cloud registry…";

  return <AmbientSplash brand={brand} msg={msg} spinning={spinning} />;
}
