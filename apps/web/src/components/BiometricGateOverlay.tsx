import { useEffect, useState } from "react";
import { getTier1Gate } from "../lib/security/tier1";

type Props = {
  open: boolean;
  reason: string;
  onSuccess: () => void;
  onCancel: () => void;
};

/** Full-screen biometric / WebAuthn UV challenge overlay. */
export function BiometricGateOverlay({ open, reason, onSuccess, onCancel }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(true);
    getTier1Gate()
      .authenticate({
        reason,
        allowDeviceCredential: false,
        strongOnly: true,
      })
      .then(() => onSuccess())
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Authentication failed");
      })
      .finally(() => setBusy(false));
  }, [open, reason, onSuccess]);

  if (!open) return null;

  return (
    <div className="biometric-gate" role="dialog" aria-modal="true" aria-label="Biometric gate">
      <div className="biometric-gate-panel">
        <div className="biometric-gate-mark" aria-hidden="true" />
        <h2>TrustID</h2>
        <p className="sub">{reason}</p>
        <p className="muted">
          {busy ? "Waiting for biometricù" : "Use Face ID, Touch ID, or fingerprint."}
        </p>
        {error && <p className="error">{error}</p>}
        <div className="inline-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => {
            setError(null);
            setBusy(true);
            getTier1Gate()
              .authenticate({ reason, allowDeviceCredential: false, strongOnly: true })
              .then(() => onSuccess())
              .catch((e) => setError(e instanceof Error ? e.message : "Failed"))
              .finally(() => setBusy(false));
          }}>
            Try again
          </button>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
