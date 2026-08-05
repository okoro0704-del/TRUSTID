import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";

type Summary = {
  identity: { trustId: string; status: string; name: string | null };
  trust: {
    tier: number;
    label: string;
    trustedDevices: number;
    identityVerification: { status: string };
    governmentVerified: boolean;
  };
  counts: {
    trustedDevices: number;
    connectedApplications: number;
    activeSessions: number;
    passkeys: number;
  };
  recentEvents: { id: string; type: string; createdAt: string }[];
  recommendations: string[];
};

export function OverviewPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Summary>("/trust/summary")
      .then(setSummary)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      );
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!summary) return <p className="muted">Loading Trust Center…</p>;

  return (
    <div className="dashboard">
      <section className="section">
        <h2>Identity control center</h2>
        <p className="sub">
          Manage your TrustID, trusted devices, applications, and security from
          one place.
        </p>
        <div className="identity-block">
          <div className="name">{summary.identity.name ?? "—"}</div>
          <div className="tid">{summary.identity.trustId}</div>
          <div className="muted">
            Account: <span className="status-ok">{summary.identity.status}</span>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Trust status</h2>
        <div className="stat-grid">
          <div className="stat">
            <div className="stat-label">Trust level</div>
            <div className="stat-value">Tier {summary.trust.tier}</div>
            <div className="muted">{summary.trust.label}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Identity verification</div>
            <div className="stat-value">
              {summary.trust.identityVerification.status === "verified"
                ? "Verified"
                : "Not verified"}
            </div>
            <div className="muted">Government ID not required for Tier 1</div>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>At a glance</h2>
        <div className="stat-grid">
          <Link className="stat linkish" to="/dashboard/devices">
            <div className="stat-label">Trusted devices</div>
            <div className="stat-value">{summary.counts.trustedDevices}</div>
          </Link>
          <Link className="stat linkish" to="/dashboard/applications">
            <div className="stat-label">Connected apps</div>
            <div className="stat-value">{summary.counts.connectedApplications}</div>
          </Link>
          <Link className="stat linkish" to="/dashboard/sessions">
            <div className="stat-label">Active sessions</div>
            <div className="stat-value">{summary.counts.activeSessions}</div>
          </Link>
          <Link className="stat linkish" to="/dashboard/passkeys">
            <div className="stat-label">Passkeys</div>
            <div className="stat-value">{summary.counts.passkeys}</div>
          </Link>
        </div>
      </section>

      <section className="section">
        <h2>Security recommendations</h2>
        <ul className="list">
          {summary.recommendations.map((r) => (
            <li key={r} className="row">
              <span className="muted">{r}</span>
            </li>
          ))}
          {summary.recommendations.length === 0 && (
            <li className="row">
              <span className="status-ok">No urgent recommendations</span>
            </li>
          )}
        </ul>
      </section>

      <section className="section">
        <h2>Recent security events</h2>
        <ul className="list">
          {summary.recentEvents.map((ev) => (
            <li key={ev.id} className="row">
              <span className="event-type">{ev.type}</span>
              <span className="muted">{new Date(ev.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
        <Link className="btn btn-ghost" to="/dashboard/security">
          Open Security Center
        </Link>
      </section>
    </div>
  );
}
