import { useEffect, useState } from "react";
import { api } from "../../lib/api";

type Session = {
  id: string;
  applicationName: string;
  deviceName: string | null;
  browser?: string;
  location?: string;
  createdAt: string;
  lastSeenAt: string;
  current?: boolean;
};

export function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setSessions(await api<Session[]>("/sessions"));
  }

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load"),
    );
  }, []);

  async function endSession(id: string) {
    await api(`/sessions/${id}`, { method: "DELETE" });
    await load();
  }

  async function endOthers() {
    await api("/sessions/revoke-all", { method: "POST" });
    await load();
  }

  return (
    <div className="dashboard">
      <section className="section">
        <h2>Active sessions</h2>
        <p className="sub">
          End sessions you do not recognize. This invalidates that session
          immediately.
        </p>
        <div className="inline-actions">
          <button className="btn btn-danger" type="button" onClick={endOthers}>
            End all other sessions
          </button>
        </div>
        <ul className="list">
          {sessions.map((s) => (
            <li key={s.id} className="row">
              <div className="row-main">
                <strong>
                  {s.applicationName}
                  {s.current ? " · This session" : ""}
                </strong>
                <span className="muted">
                  {s.deviceName ?? "Unknown device"} · {s.browser ?? "Browser"}
                </span>
                <span className="muted">{s.location}</span>
                <span className="muted">
                  Started {new Date(s.createdAt).toLocaleString()} · Last activity{" "}
                  {new Date(s.lastSeenAt).toLocaleString()}
                </span>
              </div>
              {!s.current && (
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => endSession(s.id)}
                >
                  End session
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
