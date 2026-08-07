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
  if (!summary) {
    return (
      <div className="app-loading">
        <div className="app-loading-ring" />
        <p className="muted">Synchronizing trust state…</p>
      </div>
    );
  }

  const tierPct = Math.min(100, ((summary.trust.tier + 1) / 4) * 100);
  const verified =
    summary.trust.identityVerification.status === "verified";

  return (
    <div className="dashboard home-dash">
      <section className="trust-hero-card">
        <div className="trust-ring-wrap" aria-hidden="true">
          <svg className="trust-ring" viewBox="0 0 120 120">
            <circle className="trust-ring-track" cx="60" cy="60" r="52" />
            <circle
              className="trust-ring-value"
              cx="60"
              cy="60"
              r="52"
              style={{
                strokeDasharray: `${(tierPct / 100) * 327} 327`,
              }}
            />
          </svg>
          <div className="trust-ring-center">
            <span className="trust-ring-tier">T{summary.trust.tier}</span>
            <span className="trust-ring-label">{summary.trust.label}</span>
          </div>
        </div>
        <div className="trust-hero-copy">
          <p className="continue-eyebrow">Your identity</p>
          <h2 className="trust-hero-name">{summary.identity.name ?? "—"}</h2>
          <p className="tid">{summary.identity.trustId}</p>
          <p className="muted">
            Status{" "}
            <span className="status-ok">{summary.identity.status}</span>
            {" · "}
            {verified ? "Identity verified" : "Device trust only"}
          </p>
        </div>
      </section>

      <section className="quick-grid">
        <Link className="quick-tile" to="/dashboard/devices">
          <span className="quick-value">{summary.counts.trustedDevices}</span>
          <span className="quick-label">Devices</span>
        </Link>
        <Link className="quick-tile" to="/dashboard/applications">
          <span className="quick-value">
            {summary.counts.connectedApplications}
          </span>
          <span className="quick-label">Apps</span>
        </Link>
        <Link className="quick-tile" to="/dashboard/sessions">
          <span className="quick-value">{summary.counts.activeSessions}</span>
          <span className="quick-label">Sessions</span>
        </Link>
        <Link className="quick-tile" to="/dashboard/passkeys">
          <span className="quick-value">{summary.counts.passkeys}</span>
          <span className="quick-label">Passkeys</span>
        </Link>
      </section>

      <section className="section surface-block">
        <div className="section-head">
          <h2>Protect</h2>
          <Link className="text-link" to="/dashboard/security">
            All tools
          </Link>
        </div>
        <div className="action-rail">
          <Link className="action-chip" to="/dashboard/approvals">
            Approvals
          </Link>
          <Link className="action-chip" to="/dashboard/passkeys">
            Passkeys
          </Link>
          <Link className="action-chip" to="/dashboard/sessions">
            Sessions
          </Link>
          <Link className="action-chip" to="/dashboard/temporary">
            Temporary
          </Link>
          <Link className="action-chip" to="/dashboard/notifications">
            Alerts
          </Link>
        </div>
      </section>

      <section className="section surface-block">
        <h2>Guidance</h2>
        <ul className="list compact-list">
          {summary.recommendations.map((r) => (
            <li key={r} className="row tip-row">
              <span className="tip-dot" aria-hidden="true" />
              <span className="muted">{r}</span>
            </li>
          ))}
          {summary.recommendations.length === 0 && (
            <li className="row">
              <span className="status-ok">Your trust posture looks healthy</span>
            </li>
          )}
        </ul>
      </section>

      <section className="section surface-block">
        <div className="section-head">
          <h2>Activity</h2>
          <Link className="text-link" to="/dashboard/security">
            History
          </Link>
        </div>
        <ul className="list compact-list">
          {summary.recentEvents.map((ev) => (
            <li key={ev.id} className="row">
              <span className="event-type">{ev.type}</span>
              <span className="muted">
                {new Date(ev.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
          {summary.recentEvents.length === 0 && (
            <li className="row">
              <span className="muted">No recent events</span>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
