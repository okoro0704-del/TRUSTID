import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { startRegistration } from "@simplewebauthn/browser";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

type Device = {
  id: string;
  name: string;
  status: string;
  lastActiveLabel: string;
};

type AppRow = {
  id: string;
  name: string;
  connected: boolean;
  authorizationId: string | null;
  grantedScopes: string[];
};

type SessionRow = {
  id: string;
  applicationName: string;
  deviceName: string | null;
  lastSeenAt: string;
  current?: boolean;
};

type EventRow = {
  id: string;
  type: string;
  createdAt: string;
};

type Pairing = {
  id: string;
  status: string;
  requestingDeviceMeta: Record<string, unknown>;
  createdAt: string;
};

export function DashboardPage() {
  const { identity, logout, refresh } = useAuth();
  const navigate = useNavigate();
  const [devices, setDevices] = useState<Device[]>([]);
  const [apps, setApps] = useState<AppRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [pairings, setPairings] = useState<Pairing[]>([]);
  const [newDeviceName, setNewDeviceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [d, a, s, e, p] = await Promise.all([
      api<Device[]>("/devices"),
      api<AppRow[]>("/applications"),
      api<SessionRow[]>("/sessions"),
      api<EventRow[]>("/security/events"),
      api<Pairing[]>("/devices/pairing-requests"),
    ]);
    setDevices(d);
    setApps(a);
    setSessions(s);
    setEvents(e);
    setPairings(p.filter((x) => x.status === "pending"));
  }

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load dashboard"),
    );
  }, []);

  async function onLogout() {
    await logout();
    navigate("/");
  }

  async function revokeDevice(id: string) {
    await api(`/devices/${id}`, { method: "DELETE" });
    await load();
    await refresh();
  }

  async function renameDevice(id: string, name: string) {
    const next = window.prompt("Device name", name);
    if (!next?.trim()) return;
    await api(`/devices/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: next.trim() }),
    });
    await load();
  }

  async function revokeAuth(id: string) {
    await api(`/authorizations/${id}`, { method: "DELETE" });
    await load();
  }

  async function revokeSession(id: string) {
    await api(`/sessions/${id}`, { method: "DELETE" });
    await load();
  }

  async function addDevice(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const options = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
        "/devices/register/options",
        { method: "POST", body: "{}" },
      );
      const response = await startRegistration({ optionsJSON: options });
      await api("/devices/register/verify", {
        method: "POST",
        body: JSON.stringify({
          deviceName: newDeviceName || undefined,
          response,
        }),
      });
      setNewDeviceName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add device");
    } finally {
      setBusy(false);
    }
  }

  async function createPairing() {
    await api("/devices/pairing-requests", {
      method: "POST",
      body: JSON.stringify({
        name: "New device",
        location: "Approximate location unavailable",
      }),
    });
    await load();
  }

  async function resolvePairing(id: string, action: "approve" | "reject") {
    await api(`/devices/pairing-requests/${id}/${action}`, { method: "POST" });
    await load();
  }

  if (!identity) return null;

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">TrustID</div>
        <button className="btn btn-ghost" onClick={onLogout}>
          Sign out
        </button>
      </div>

      <div className="dashboard">
        <section className="section">
          <h2>Identity</h2>
          <p className="sub">Your permanent ecosystem identity.</p>
          <div className="identity-block">
            <div className="name">{identity.profile?.name ?? "—"}</div>
            <div className="tid">{identity.trustId}</div>
            <div className="muted">
              Status: <span className="status-ok">{identity.status}</span>
            </div>
          </div>
        </section>

        <section className="section">
          <h2>Connected applications</h2>
          <p className="sub">Apps authenticate through TrustID — never with a separate consumer identity.</p>
          <ul className="list">
            {apps.map((app) => (
              <li key={app.id} className="row">
                <div className="row-main">
                  <strong>{app.name}</strong>
                  <span className={app.connected ? "status-ok" : "status-off"}>
                    {app.connected ? "Connected" : "Not connected"}
                  </span>
                  {app.connected && app.grantedScopes.length > 0 && (
                    <span className="muted">{app.grantedScopes.join(" · ")}</span>
                  )}
                </div>
                {app.connected && app.authorizationId && (
                  <button
                    className="btn btn-danger"
                    onClick={() => revokeAuth(app.authorizationId!)}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="section">
          <h2>Trusted devices</h2>
          <p className="sub">Passkey-bound devices you trust.</p>
          <ul className="list">
            {devices.map((d) => (
              <li key={d.id} className="row">
                <div className="row-main">
                  <strong>{d.name}</strong>
                  <span className={d.status === "trusted" ? "status-ok" : "status-off"}>
                    {d.status === "trusted" ? "Trusted" : "Revoked"}
                  </span>
                  <span className="muted">Last active: {d.lastActiveLabel}</span>
                </div>
                {d.status === "trusted" && (
                  <div className="inline-actions">
                    <button className="btn btn-ghost" onClick={() => renameDevice(d.id, d.name)}>
                      Rename
                    </button>
                    <button className="btn btn-danger" onClick={() => revokeDevice(d.id)}>
                      Revoke
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <form className="inline-actions" onSubmit={addDevice}>
            <input
              value={newDeviceName}
              onChange={(e) => setNewDeviceName(e.target.value)}
              placeholder="New device name"
              style={{
                background: "rgba(7,30,28,0.55)",
                border: "1px solid var(--line)",
                borderRadius: 12,
                color: "var(--foam)",
                padding: "0.7rem 0.85rem",
              }}
            />
            <button className="btn btn-primary" disabled={busy}>
              Add device passkey
            </button>
            <button className="btn btn-ghost" type="button" onClick={createPairing}>
              Request pairing
            </button>
          </form>
          {pairings.length > 0 && (
            <ul className="list">
              {pairings.map((p) => (
                <li key={p.id} className="row">
                  <div className="row-main">
                    <strong>New device wants access</strong>
                    <span className="muted">
                      {(p.requestingDeviceMeta.name as string) || "Unknown device"} ·{" "}
                      {new Date(p.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="inline-actions">
                    <button className="btn btn-primary" onClick={() => resolvePairing(p.id, "approve")}>
                      Approve
                    </button>
                    <button className="btn btn-danger" onClick={() => resolvePairing(p.id, "reject")}>
                      Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="section">
          <h2>Security</h2>
          <p className="sub">Active sessions and recent activity.</p>
          <h3 style={{ margin: "0.5rem 0 0", fontSize: "1rem" }}>Active sessions</h3>
          <ul className="list">
            {sessions.map((s) => (
              <li key={s.id} className="row">
                <div className="row-main">
                  <strong>{s.applicationName}</strong>
                  <span className="muted">
                    {s.deviceName ?? "Unknown device"}
                    {s.current ? " · This session" : ""}
                  </span>
                  <span className="muted">
                    Last seen {new Date(s.lastSeenAt).toLocaleString()}
                  </span>
                </div>
                {!s.current && (
                  <button className="btn btn-danger" onClick={() => revokeSession(s.id)}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
          <h3 style={{ margin: "0.5rem 0 0", fontSize: "1rem" }}>Recent activity</h3>
          <ul className="list">
            {events.slice(0, 12).map((ev) => (
              <li key={ev.id} className="row">
                <span className="event-type">{ev.type}</span>
                <span className="muted">{new Date(ev.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
