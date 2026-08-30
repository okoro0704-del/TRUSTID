type CreateTrustIdAccountProps = {
  busy?: boolean;
  error?: string | null;
  brand?: string;
  onCreate: () => void;
};

/**
 * 1-click passkey registration — zero text fields.
 * Shown when the silent probe finds no Trust ID passkey on this device.
 */
export function CreateTrustIdAccount({
  busy = false,
  error = null,
  brand = "TrustID",
  onCreate,
}: CreateTrustIdAccountProps) {
  return (
    <div className="tid-create-account">
      <div className="tid-create-account-ambient" aria-hidden="true" />
      <main className="tid-create-account-panel">
        <div className="tid-create-account-orb" aria-hidden="true">
          <span />
          <span />
        </div>
        <p className="tid-create-account-eyebrow">No passkey on this device</p>
        <h1 className="tid-create-account-brand">{brand}</h1>
        <p className="tid-create-account-lead">
          No active Trust ID passkey was found on this device. Create one with
          Face ID or Fingerprint — no email, phone, or password.
        </p>
        {error && <p className="tid-error">{error}</p>}
        <button
          type="button"
          className="tid-btn tid-btn-primary tid-create-account-cta"
          disabled={busy}
          onClick={onCreate}
        >
          {busy
            ? "Creating passkey…"
            : "Create Trust ID Passkey with Face ID / Fingerprint"}
        </button>
        <p className="tid-muted tid-create-account-foot">
          Biometrics never leave this device. Trust ID stores cryptographic proof
          only.
        </p>
      </main>
    </div>
  );
}
