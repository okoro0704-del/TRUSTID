import type { ReactNode } from "react";
import {
  useAmbientTrustIdAuth,
  type UseAmbientTrustIdAuthOptions,
} from "../hooks/useAmbientTrustIdAuth.js";
import { RegistrationPromptModal } from "./RegistrationPromptModal.js";

export type TrustIdAmbientAuthProviderProps = UseAmbientTrustIdAuthOptions & {
  children: ReactNode;
  brand?: string;
};

function AmbientSplash({
  brand,
  msg,
  children,
}: {
  brand: string;
  msg: string;
  children?: ReactNode;
}) {
  return (
    <div className="tid-ambient-splash" role="status" aria-live="polite">
      <div className="tid-ambient-splash-panel">
        <div className="tid-silent-splash-mark" aria-hidden="true" />
        <h1 className="tid-silent-splash-brand">{brand}</h1>
        <p className="tid-ambient-splash-msg">{msg}</p>
        {children}
        {!children ? (
          <div className="tid-silent-splash-ring" aria-hidden="true" />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Global identity-first auth shell ù lookup before any enroll write.
 */
export function TrustIdAmbientAuthProvider({
  children,
  brand = "TrustID",
  ...options
}: TrustIdAmbientAuthProviderProps) {
  const {
    phase,
    error,
    retry,
    confirmSwitchAccount,
    confirmCreateAccount,
    declineCreateAccount,
    continueAfterDeviceSaved,
    confirmFingerprintBackup,
    skipFingerprintBackup,
    continueAfterApproval,
    lastResult,
    previousTrustId,
  } = useAmbientTrustIdAuth(options);

  if (phase === "AUTHENTICATED") {
    return <>{children}</>;
  }

  if (phase === "OFFER_CREATE") {
    return (
      <>
        <AmbientSplash
          brand={brand}
          msg="Your face is not in the Trust ID registry yet."
        >
          <p className="tid-ambient-splash-msg" style={{ marginTop: "0.75rem" }}>
            Create a Trust ID with this face. This phone becomes your Master Device.
          </p>
          <div className="tid-ambient-splash-actions">
            <button
              type="button"
              className="tid-btn tid-btn-primary"
              onClick={confirmCreateAccount}
            >
              Create Trust ID
            </button>
            <button type="button" className="tid-btn tid-btn-ghost" onClick={retry}>
              Scan face again
            </button>
            <button
              type="button"
              className="tid-btn tid-btn-ghost"
              onClick={declineCreateAccount}
            >
              Cancel
            </button>
          </div>
        </AmbientSplash>
        <RegistrationPromptModal
          isOpen
          title="No Trust ID Found"
          message={
            <>
              We scanned your face, but there is no matching Trust ID on the
              network.
              <br />
              <br />
              Create one now? This device will be saved as your Master Device.
            </>
          }
          onAccept={confirmCreateAccount}
          onDecline={declineCreateAccount}
        />
      </>
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
            your Master Device to allow this terminalù
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
    const canCreate = Boolean(lastResult?.enrolled === false || lastResult == null);
    return (
      <div className="tid-ambient-splash" role="alert">
        <div className="tid-ambient-splash-panel">
          <h1 className="tid-silent-splash-brand">{brand}</h1>
          <p className="tid-ambient-splash-msg">{error ?? "Verification paused"}</p>
          <div className="tid-ambient-splash-actions">
            <button type="button" className="tid-btn tid-btn-primary" onClick={retry}>
              Retry face verification
            </button>
            {canCreate ? (
              <button
                type="button"
                className="tid-btn tid-btn-ghost"
                onClick={confirmCreateAccount}
              >
                Create Trust ID
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const msg =
    phase === "ENROLLING"
      ? "Creating your Trust ID and binding this Master Deviceù"
      : phase === "SAVING_FINGERPRINT"
        ? "Scan your fingerprint to save an alternative unlockù"
        : "Looking at your face and matching the Trust ID cloud registryù";

  return <AmbientSplash brand={brand} msg={msg} />;
}
