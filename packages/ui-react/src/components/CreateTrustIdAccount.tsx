type CreateTrustIdAccountProps = {
  busy?: boolean;
  error?: string | null;
  brand?: string;
  onCreate: () => void;
};

/**
 * Zero-field account creation — one biometric action only.
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
        <p className="tid-create-account-eyebrow">New on this device</p>
        <h1 className="tid-create-account-brand">{brand}</h1>
        <p className="tid-create-account-lead">
          Create your Trust ID with a single biometric scan. No email, phone, or
          password — your secure enclave is the key.
        </p>
        {error && <p className="tid-error">{error}</p>}
        <button
          type="button"
          className="tid-btn tid-btn-primary tid-create-account-cta"
          disabled={busy}
          onClick={onCreate}
        >
          {busy
            ? "Creating…"
            : "Create Trust ID with Face ID / Fingerprint"}
        </button>
        <p className="tid-muted tid-create-account-foot">
          Biometrics never leave this device. Trust ID stores cryptographic proof
          only.
        </p>
      </main>
    </div>
  );
}
