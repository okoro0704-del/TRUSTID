import { useEffect, useState } from "react";
import { SCOPE_LABELS } from "@trustid/shared";
import { api } from "../../lib/api";

type AppRow = {
  id: string;
  name: string;
  logoUrl?: string | null;
  connected: boolean;
  authorizationId: string | null;
  grantedScopes: string[];
  connectedAt?: string | null;
  lastAccessAt?: string | null;
};

type AuthDetail = {
  id: string;
  application: { name: string; logoUrl?: string | null };
  scopes: string[];
  grantedAt: string;
  status: string;
};

export function ApplicationsPage() {
  const [apps, setApps] = useState<AppRow[]>([]);
  const [selected, setSelected] = useState<AuthDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [a, auths] = await Promise.all([
      api<AppRow[]>("/applications"),
      api<AuthDetail[]>("/authorizations"),
    ]);
    setApps(a);
    return auths;
  }

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load"),
    );
  }, []);

  async function disconnect(id: string) {
    if (!window.confirm("Disconnect this application? It will need to ask again.")) {
      return;
    }
    await api(`/authorizations/${id}`, { method: "DELETE" });
    setSelected(null);
    await load();
  }

  async function review(authorizationId: string) {
    const auths = await api<AuthDetail[]>("/authorizations");
    setSelected(auths.find((a) => a.id === authorizationId) ?? null);
  }

  return (
    <div className="dashboard">
      <section className="section">
        <h2>Connected applications</h2>
        <p className="sub">
          Apps authenticate through TrustID. Disconnecting revokes their tokens
          and granted permissions.
        </p>
        <ul className="list">
          {apps.map((app) => (
            <li key={app.id} className="row">
              <div className="row-main">
                <strong>{app.name}</strong>
                <span className={app.connected ? "status-ok" : "status-off"}>
                  {app.connected ? "Connected" : "Not connected"}
                </span>
                {app.connected && app.connectedAt && (
                  <span className="muted">
                    Connected {new Date(app.connectedAt).toLocaleDateString()}
                    {app.lastAccessAt
                      ? ` · Last access ${new Date(app.lastAccessAt).toLocaleDateString()}`
                      : ""}
                  </span>
                )}
                {app.connected && (
                  <span className="muted">
                    {app.grantedScopes
                      .map((s) => SCOPE_LABELS[s] ?? s)
                      .join(" · ")}
                  </span>
                )}
              </div>
              {app.connected && app.authorizationId && (
                <div className="inline-actions">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => review(app.authorizationId!)}
                  >
                    Permissions
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => disconnect(app.authorizationId!)}
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {selected && (
        <section className="section">
          <h2>Permissions — {selected.application.name}</h2>
          <p className="muted">
            Connected {new Date(selected.grantedAt).toLocaleString()}
          </p>
          <ul className="list">
            {selected.scopes.map((s) => (
              <li key={s} className="row">
                <span>{SCOPE_LABELS[s] ?? s}</span>
                <span className="event-type">{s}</span>
              </li>
            ))}
          </ul>
          <button className="btn btn-ghost" type="button" onClick={() => setSelected(null)}>
            Close
          </button>
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
