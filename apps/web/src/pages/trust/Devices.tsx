import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { reauthenticate } from "../../lib/reauth";

type Device = {
  id: string;
  name: string;
  status: string;
  trustLevel?: string;
  current?: boolean;
  platform: string | null;
  deviceType: string | null;
  userAgent: string | null;
  createdAt: string;
  lastActiveLabel: string;
  trusted: boolean;
};

type Enrollment = {
  id: string;
  pairingCode: string;
  joinUrl: string;
  expiresAt: string;
  status: string;
};

function trustLabel(level?: string) {
  if (level === "primary") return "Primary";
  if (level === "temporary") return "Temporary";
  return "Standard";
}

export function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [pending, setPending] = useState<
    { id: string; pairingCode?: string | null; status: string }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [d, p] = await Promise.all([
      api<Device[]>("/devices"),
      api<{ id: string; pairingCode?: string | null; status: string }[]>(
        "/devices/pairing-requests",
      ),
    ]);
    setDevices(d.filter((x) => x.trustLevel !== "temporary"));
    setPending(p.filter((x) => x.status === "pending"));
  }

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load devices"),
    );
  }, []);

  async function rename(id: string, name: string) {
    const next = window.prompt("Device name", name);
    if (!next?.trim()) return;
    await api(`/devices/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: next.trim() }),
    });
    await load();
  }

  async function revoke(id: string) {
    if (
      !window.confirm(
        "Revoke this trusted device? Confirm with your passkey on this primary device.",
      )
    ) {
      return;
    }
    try {
      const response = await reauthenticate();
      await api(`/devices/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ response }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revoke failed");
    }
  }

  async function promote(id: string) {
    if (!window.confirm("Make this device Primary? Confirm with your passkey.")) {
      return;
    }
    try {
      const response = await reauthenticate();
      await api(`/devices/${id}/promote`, {
        method: "POST",
        body: JSON.stringify({ response }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Promote failed");
    }
  }

  async function startEnrollment(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const invite = await api<Enrollment>("/devices/enrollment", {
        method: "POST",
        body: "{}",
      });
      setEnrollment(invite);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start enrollment");
    } finally {
      setBusy(false);
    }
  }

  async function approve(id: string) {
    await api(`/devices/enrollment/${id}/approve`, { method: "POST" });
    await load();
  }

  return (
    <div className="dashboard">
      <section className="section">
        <h2>Trusted devices</h2>
        <p className="sub">
          Primary devices approve new sign-ins. Revoking ends sessions and blocks
          that credential. See also{" "}
          <Link to="/dashboard/temporary">temporary devices</Link> and{" "}
          <Link to="/dashboard/approvals">approval requests</Link>.
        </p>
        <ul className="list">
          {devices.map((d) => (
            <li key={d.id} className="row">
              <div className="row-main">
                <strong>
                  {d.name}
                  {d.current ? " · This device" : ""}
                </strong>
                <span className={d.trusted ? "status-ok" : "status-off"}>
                  {d.trusted ? `✓ ${trustLabel(d.trustLevel)}` : "Revoked"}
                </span>
                <span className="muted">
                  {d.platform ?? d.deviceType ?? "Platform unknown"} · Last used{" "}
                  {d.lastActiveLabel}
                </span>
                <span className="muted">
                  Registered {new Date(d.createdAt).toLocaleDateString()}
                </span>
              </div>
              {d.trusted && (
                <div className="inline-actions">
                  <Link className="btn btn-ghost" to={`/dashboard/devices/${d.id}`}>
                    Details
                  </Link>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => rename(d.id, d.name)}
                  >
                    Rename
                  </button>
                  {d.trustLevel !== "primary" && (
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => promote(d.id)}
                    >
                      Make primary
                    </button>
                  )}
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => revoke(d.id)}
                  >
                    Revoke
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <h2>Add trusted device</h2>
        <p className="sub">
          Generate a one-time code, or have the new device request approval from
          Continue with TrustID.
        </p>
        <form onSubmit={startEnrollment}>
          <button className="btn btn-primary" disabled={busy} type="submit">
            {busy ? "Creating…" : "Generate enrollment code"}
          </button>
        </form>
        {enrollment && (
          <div className="panel" style={{ marginTop: "1rem", width: "100%" }}>
            <p className="notice">Code: {enrollment.pairingCode}</p>
            <p className="muted">
              Expires {new Date(enrollment.expiresAt).toLocaleString()}
            </p>
            <p className="muted break-all">{enrollment.joinUrl}</p>
          </div>
        )}
        {pending.length > 0 && (
          <ul className="list">
            {pending.map((p) => (
              <li key={p.id} className="row">
                <div className="row-main">
                  <strong>Pending enrollment</strong>
                  <span className="muted">{p.pairingCode ?? p.id}</span>
                </div>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => approve(p.id)}
                >
                  Approve
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
