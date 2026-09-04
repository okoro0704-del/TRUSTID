import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";

type PrimitiveBinding = {
  id: string;
  mode: string;
  bound: boolean;
  role: string;
};

/**
 * Identity-first home — vault/media are device privacy tools that consume DataZone/ElfCom.
 */
export function OverviewPage() {
  const [bindings, setBindings] = useState<PrimitiveBinding[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ primitives: PrimitiveBinding[] }>("/ecosystem/status")
      .then((s) => setBindings(s.primitives ?? []))
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      );
  }, []);

  const boundCount = bindings.filter((b) => b.bound).length;

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="dashboard home-dash">
      <section className="section surface-block">
        <p className="continue-eyebrow">TrustID</p>
        <h2>Your identity layer</h2>
        <p className="sub">
          Passkeys, devices, and approvals stay here. Push, storage, and payments
          are consumed from ElfCom, DataZone, FinProv, LIDIOS, and Digiconomy.
        </p>
      </section>

      <section className="quick-grid consumer-quick">
        <Link className="quick-tile consumer-tile" to="/dashboard/ecosystem">
          <span className="quick-value">
            {bindings.length ? `${boundCount}/${bindings.length}` : "—"}
          </span>
          <span className="quick-label">BaaS bound</span>
          <span className="muted">Ecosystem status</span>
        </Link>
        <Link className="quick-tile consumer-tile" to="/dashboard/devices">
          <span className="quick-value">Devices</span>
          <span className="quick-label">Trusted terminals</span>
          <span className="muted">Identity core</span>
        </Link>
        <Link className="quick-tile consumer-tile" to="/dashboard/approvals">
          <span className="quick-value">Approvals</span>
          <span className="quick-label">Master consent</span>
          <span className="muted">via ElfCom push</span>
        </Link>
        <Link className="quick-tile consumer-tile" to="/dashboard/notifications">
          <span className="quick-value">Alerts</span>
          <span className="quick-label">Security inbox</span>
          <span className="muted">ElfCom-first</span>
        </Link>
      </section>

      <section className="section surface-block">
        <h2>Get started</h2>
        <div className="action-rail">
          <Link className="action-chip" to="/dashboard/identity">
            Identity
          </Link>
          <Link className="action-chip" to="/dashboard/passkeys">
            Passkeys
          </Link>
          <Link className="action-chip" to="/dashboard/control">
            Logins & devices
          </Link>
          <Link className="action-chip" to="/dashboard/ecosystem">
            Ecosystem
          </Link>
        </div>
      </section>
    </div>
  );
}
