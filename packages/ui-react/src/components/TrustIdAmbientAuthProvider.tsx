import type { ReactNode } from "react";
import type { FaceLifecycleDiagnostics, FaceScanReason } from "@trustid/shared";
import {
  BIOMETRIC_RELOAD_REQUIRED_ERROR,
  BIOMETRIC_UNAVAILABLE_ERROR,
  useAmbientTrustIdAuth,
  type FaceScanStage,
  type UseAmbientTrustIdAuthOptions,
} from "../hooks/useAmbientTrustIdAuth.js";

const FACE_NOT_READ_HINTS: Partial<Record<FaceScanReason, string>> = {
  CAMERA_UNAVAILABLE: "Allow camera access for TrustID, then retry.",
  NO_VIDEO_FRAME: "The camera didn't send a picture. Close other apps using the camera, then retry.",
  MODELS_NOT_READY: "Face recognition is still loading. Retry in a moment.",
  NO_FACE_DETECTED: "Hold the phone at eye level with your whole face in view.",
  MULTIPLE_FACES: "Make sure only your face is in view.",
  FACE_TOO_SMALL: "Move the phone closer to your face.",
  FACE_OUT_OF_BOUNDS: "Center your face in the camera view.",
  LOW_LIGHT: "Move somewhere brighter.",
  OVEREXPOSED: "Avoid strong light shining on you or behind you.",
  EXCESSIVE_BLUR: "Hold the phone steady.",
  POSE_REJECTED: "Look straight at the camera.",
  LIVENESS_NOT_CONFIRMED: "Blink once while looking at the camera.",
};

const DEFAULT_FACE_NOT_READ_HINT = "Look straight at the camera in good light, then retry.";

const SCAN_STAGE_MESSAGES: Record<FaceScanStage, string> = {
  camera: "Starting camera…",
  models: "Preparing face recognition…",
  scanning: "Looking for your Trust ID…",
};

/** Reason code and counters only. Never frames, landmarks or vectors. */
function scanDiagnosticsLine(d: FaceLifecycleDiagnostics | undefined): string | null {
  if (!d?.scanReason && !d?.scanCounters) return null;
  const c = d.scanCounters;
  return [
    d.scanReason ?? null,
    c
      ? `frames ${c.framesObserved}/${c.framesSubmitted} · faces ${c.facesDetected} · accepted ${c.qualityAccepted}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const SERVICE_DOWN = /BIOMETRIC_SERVICE_UNAVAILABLE|BIOMETRIC_MODEL_UNAVAILABLE|timed out/i;

/** Service failures show fixed copy; internal error detail stays in diagnostics. */
function presentServiceError(error: string): string {
  if (error === BIOMETRIC_UNAVAILABLE_ERROR || error === BIOMETRIC_RELOAD_REQUIRED_ERROR) {
    return error.replace("BIOMETRIC_SERVICE_UNAVAILABLE", "BIOMETRIC SERVICE UNAVAILABLE");
  }
  return "BIOMETRIC SERVICE UNAVAILABLE — TrustID's identification service is temporarily unavailable. Retry or use another available verification method.";
}

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
    faceDiagnostics,
    createStage,
    scanStage,
    faceScanReason,
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

  // "Not found" is only claimed after a face was actually read and searched.
  const faceWasRead = Boolean(faceDiagnostics?.vectorCreated);
  if (
    phase === "FACE_NOT_READ" ||
    ((phase === "NO_MATCH" || phase === "OFFER_CREATE") && !faceWasRead)
  ) {
    const reason = faceScanReason ?? faceDiagnostics?.scanReason ?? null;
    const hint = (reason && FACE_NOT_READ_HINTS[reason]) ?? DEFAULT_FACE_NOT_READ_HINT;
    const diagLine = scanDiagnosticsLine(faceDiagnostics);
    return (
      <AmbientSplash brand={brand} msg="We couldn't read your face">
        <p className="tid-ambient-splash-msg" style={{ marginTop: "0.65rem" }}>
          {hint}
        </p>
        <p
          className="tid-ambient-splash-msg"
          style={{ marginTop: "0.35rem", fontSize: "0.9rem", opacity: 0.85 }}
        >
          Nothing was searched yet, so this doesn't mean you don't have a TrustID.
        </p>
        {error ? (
          <p
            className="tid-ambient-splash-msg"
            style={{ marginTop: "0.65rem", color: "#fbbf24" }}
          >
            {error}
          </p>
        ) : null}
        {diagLine ? (
          <p
            className="tid-ambient-splash-msg"
            style={{ marginTop: "0.35rem", fontSize: "0.75rem", opacity: 0.75 }}
            data-testid="face-scan-diagnostics"
          >
            {diagLine}
          </p>
        ) : null}
        <div
          className="tid-ambient-choice-row"
          role="group"
          aria-label="Choose next step"
        >
          <div className="tid-ambient-choice-card tid-ambient-choice-card-primary">
            <p className="tid-ambient-choice-label">Try again</p>
            <button
              type="button"
              className="tid-btn tid-btn-primary"
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
          <div className="tid-ambient-choice-card">
            <p className="tid-ambient-choice-label">Never made a TrustID?</p>
            <button
              type="button"
              className="tid-btn"
              onClick={confirmCreateAccount}
              disabled={fingerprintBusy}
            >
              Create TrustID
            </button>
          </div>
        </div>
      </AmbientSplash>
    );
  }

  if (phase === "NO_MATCH" || phase === "OFFER_CREATE") {
    return (
      <AmbientSplash brand={brand} msg="No Trust ID found">
        <p className="tid-ambient-splash-msg" style={{ marginTop: "0.65rem" }}>
          Scan complete. No TrustID matches this face. Press Create TrustID to make one.
        </p>
        {error ? (
          <p
            className="tid-ambient-splash-msg"
            style={{ marginTop: "0.65rem", color: "#fbbf24" }}
          >
            {error}
          </p>
        ) : null}
        {faceDiagnostics?.vectorCreated || faceDiagnostics?.errorCode ? (
          <p
            className="tid-ambient-splash-msg"
            style={{ marginTop: "0.35rem", fontSize: "0.75rem", opacity: 0.75 }}
            data-testid="face-lifecycle-diagnostics"
          >
            {[
              faceDiagnostics.faceDetected ? "face_detected" : null,
              faceDiagnostics.vectorCreated ? "vector_created" : null,
              faceDiagnostics.errorCode === "FACE_NOT_ENROLLED"
                ? "face_not_enrolled"
                : faceDiagnostics.errorCode ?? null,
            ]
              .filter(Boolean)
              .join(" · ")}
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
              Create TrustID
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
    const serviceDown = SERVICE_DOWN.test(error ?? "");
    const reloadRequired = error === BIOMETRIC_RELOAD_REQUIRED_ERROR;
    const msg = serviceDown && error
      ? presentServiceError(error)
      : error ?? "Verification paused";
    return (
      <AmbientSplash brand={brand} msg={msg}>
        <div
          className="tid-ambient-choice-row"
          role="group"
          aria-label="Choose next step"
        >
          <div className="tid-ambient-choice-card">
            <p className="tid-ambient-choice-label">Try again</p>
            {reloadRequired ? (
              <button
                type="button"
                className="tid-btn"
                onClick={() => window.location.reload()}
              >
                Reload Page
              </button>
            ) : (
              <button type="button" className="tid-btn" onClick={retry}>
                Retry Face Scan
              </button>
            )}
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
              <p className="tid-ambient-choice-label">Never made a TrustID?</p>
              <button
                type="button"
                className="tid-btn tid-btn-primary"
                onClick={confirmCreateAccount}
              >
                Create TrustID
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
      ? createStage === "capturing"
        ? scanStage && scanStage !== "scanning"
          ? SCAN_STAGE_MESSAGES[scanStage]
          : "Getting your face ready — look at the camera…"
        : "Creating your TrustID…"
      : phase === "SAVING_FINGERPRINT"
        ? "Register fingerprint backup…"
        : scanStage
          ? SCAN_STAGE_MESSAGES[scanStage]
          : "Looking for your Trust ID…";

  return <AmbientSplash brand={brand} msg={msg} spinning={spinning} />;
}
