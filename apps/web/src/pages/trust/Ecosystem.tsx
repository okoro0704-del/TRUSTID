import { useEffect, useState } from "react";
import { api } from "../../lib/api";

type PrimitiveBinding = {
  id: string;
  mode: string;
  bound: boolean;
  baseUrl?: string;
  role: string;
};

type EcosystemStatus = {
  ok: boolean;
  identityProvider: string;
  primitives: PrimitiveBinding[];
  probes: Record<string, { ok?: boolean; error?: string; service?: string }>;
};

/**
 * Trust Center view of BaaS consumption — TrustID is IdP, not the monolith.
 */
export function EcosystemPage() {
  const [status, setStatus] = useState<EcosystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<EcosystemStatus>("/ecosystem/status")
      .then(setStatus)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load ecosystem"),
      );
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!status) return <p className="muted">Loading ecosystem…</p>;

  return (
    <div className="dashboard">
      <section className="section surface-block">
        <p className="continue-eyebrow">Identity Provider</p>
        <h2>Ecosystem primitives</h2>
        <p className="sub">
          TrustID authenticates people and issues scoped credentials. The five
          backend primitives handle everything else: ElfCom (messaging), DataZone
          (storage), FinProv (payments), Platform Job (async work), and Master
          Distribution (tenant/domain provisioning).
        </p>
      </section>

      <section className="section">
        <ul className="list">
          {status.primitives.map((p) => (
            <li key={p.id} className="row">
              <div className="row-main">
                <strong>
                  {p.id}{" "}
                  <span className="muted">
                    · {p.bound ? "bound" : "unbound"} · {p.mode}
                  </span>
                </strong>
                <span className="muted">{p.role}</span>
                {p.baseUrl ? (
                  <span className="muted">{p.baseUrl}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="section surface-block">
        <h2>Relying-party probes</h2>
        <p className="sub">
          LIDIOS and Digiconomy authenticate through TrustID; these health probes
          confirm outbound wiring only.
        </p>
        <ul className="list">
          {Object.entries(status.probes).map(([name, probe]) => (
            <li key={name} className="row">
              <div className="row-main">
                <strong>{name}</strong>
                <span className="muted">
                  {probe.ok
                    ? `ok${probe.service ? ` · ${probe.service}` : ""}`
                    : probe.error ?? "unreachable"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
