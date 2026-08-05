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
      <section className="section">
        <h2>Security Center</h2>
        <p className="sub">Central hub for TrustID security and assurance.</p>
        <div className="inline-actions">
          <Link className="btn btn-ghost" to="/dashboard/devices">
            Devices
          </Link>
          <Link className="btn btn-ghost" to="/dashboard/passkeys">
            Passkeys
          </Link>
          <Link className="btn btn-ghost" to="/dashboard/applications">
            Apps
          </Link>
          <Link className="btn btn-ghost" to="/dashboard/sessions">
            Sessions
          </Link>
        </div>
      </section>

      <section className="section">
        <h2>Identity verification</h2>
        <p className="sub">Future capability — not government verified today.</p>
        {verification && (
          <ul className="list">
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

      <section className="section">
        <h2>Login history</h2>
        <p className="sub">Read-only authentication history.</p>
        <ul className="list">
          {logins.map((l) => (
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

      <section className="section">
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
        <ul className="list">
          {events.map((ev) => (
            <li key={ev.id} className="row">
              <span className="event-type">{ev.type}</span>
              <span className="muted">{new Date(ev.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <h2>Recovery methods</h2>
        <p className="muted">Placeholder — high-assurance recovery comes later.</p>
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
