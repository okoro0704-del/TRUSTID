import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";

type EventRow = {
  id: string;
  type: string;
  createdAt: string;
};

type LoginRow = {
  id: string;
  time: string;
  result: string;
  method: string;
  application: string;
  deviceId: string | null;
};

type IdentityVerification = {
  status: string;
  verificationLevel: string;
  futureProvider: string;
  note: string;
};

const HUB = [
  { to: "/dashboard/vault", title: "Media vault", blurb: "Encrypted photos & videos" },
  { to: "/dashboard/app-locker", title: "App locker", blurb: "Biometric process shield" },
  { to: "/dashboard/device-sync", title: "Device sync", blurb: "E2E blind relay (X3DH)" },
  { to: "/dashboard/guardians", title: "Recovery guardians", blurb: "Shamir threshold shares" },
  { to: "/dashboard/identity", title: "Verified identity", blurb: "Portrait & verification" },
  { to: "/dashboard/devices", title: "Trusted devices", blurb: "Primary & standard" },
  { to: "/dashboard/approvals", title: "Device approvals", blurb: "Pending requests" },
  { to: "/dashboard/passkeys", title: "Passkeys", blurb: "Credentials on device" },
  { to: "/dashboard/sessions", title: "Active sessions", blurb: "End unknown access" },
  { to: "/dashboard/temporary", title: "Temporary access", blurb: "Short-lived devices" },
  { to: "/dashboard/notifications", title: "Alerts", blurb: "Security notifications" },
  { to: "/dashboard/applications", title: "Connected apps", blurb: "Permissions & revoke" },
];

export function SecurityPage() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [logins, setLogins] = useState<LoginRow[]>([]);
  const [verification, setVerification] = useState<IdentityVerification | null>(
    null,
  );
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<EventRow[]>(
        `/security/events${filter ? `?type=${encodeURIComponent(filter)}` : ""}`,
      ),
      api<LoginRow[]>("/security/login-history"),
      api<IdentityVerification>("/account/identity-verification"),
    ])
      .then(([e, l, v]) => {
        setEvents(e);
        setLogins(l);
        setVerification(v);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      );
  }, [filter]);

  return (
    <div className="dashboard">
      <section className="section surface-block">
        <h2>Security hub</h2>
        <p className="sub">
          Device privacy controls and identity trust — media vault, app locker,
          passkeys, sessions, and assurance.
        </p>
        <div className="hub-grid">
          {HUB.map((item) => (
            <Link key={item.to} className="hub-card" to={item.to}>
              <strong>{item.title}</strong>
              <span className="muted">{item.blurb}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="section surface-block">
        <h2>Identity verification</h2>
        <p className="sub">Future capability — not government verified today.</p>
        {verification && (
          <ul className="list compact-list">
            <li className="row">
              <span className="muted">Status</span>
              <span>{verification.status}</span>
            </li>
            <li className="row">
              <span className="muted">Verification level</span>
              <span>{verification.verificationLevel}</span>
            </li>
            <li className="row">
              <span className="muted">Future provider</span>
              <span>{verification.futureProvider}</span>
            </li>
          </ul>
        )}
        <p className="muted">{verification?.note}</p>
      </section>

      <section className="section surface-block">
        <h2>Login history</h2>
        <p className="sub">Read-only authentication history.</p>
        <ul className="list compact-list">
          {logins.slice(0, 8).map((l) => (
            <li key={l.id} className="row">
              <div className="row-main">
                <strong>{l.result}</strong>
                <span className="muted">
                  {l.method} · {l.application}
                </span>
              </div>
              <span className="muted">{new Date(l.time).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="section surface-block">
        <h2>Security events</h2>
        <div className="field">
          <label htmlFor="filter">Filter by event type</label>
          <input
            id="filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="e.g. device.revoked"
          />
        </div>
        <ul className="list compact-list">
          {events.slice(0, 12).map((ev) => (
            <li key={ev.id} className="row">
              <span className="event-type">{ev.type}</span>
              <span className="muted">{new Date(ev.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="section surface-block">
        <h2>Recovery methods</h2>
        <p className="muted">Placeholder — high-assurance recovery comes later.</p>
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
