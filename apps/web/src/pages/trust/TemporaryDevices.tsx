import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";

type TempDevice = {
  id: string;
  name: string;
  platform: string | null;
  trustLevel: string;
  expiresAt: string | null;
  lastActiveAt: string | null;
  applicationName: string;
  sessionId: string | null;
};

export function TemporaryDevicesPage() {
  const [devices, setDevices] = useState<TempDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setDevices(await api<TempDevice[]>("/devices/temporary"));
  }

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load"),
    );
  }, []);

  async function terminate(id: string) {
    if (!window.confirm("End temporary access for this device?")) return;
    await api(`/devices/temporary/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="dashboard">
      <section className="section">
        <h2>Temporary devices</h2>
        <p className="sub">
          These devices have short-lived sessions without a trusted passkey.
          Terminate anytime, or convert to trusted via a new approval.
        </p>
        <ul className="list">
          {devices.map((d) => (
            <li key={d.id} className="row">
              <div className="row-main">
                <strong>{d.name}</strong>
                <span className="muted">
                  {d.applicationName} · {d.platform ?? "Platform unknown"}
                </span>
                <span className="muted">
                  Expires{" "}
                  {d.expiresAt
                    ? new Date(d.expiresAt).toLocaleString()
                    : "soon"}
                  {d.lastActiveAt
                    ? ` · Last activity ${new Date(d.lastActiveAt).toLocaleString()}`
                    : ""}
                </span>
              </div>
              <div className="inline-actions">
                <Link className="btn btn-ghost" to="/dashboard/approvals">
                  Convert to trusted
                </Link>
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => terminate(d.id)}
                >
                  Terminate
                </button>
              </div>
            </li>
          ))}
          {devices.length === 0 && (
            <li className="row">
              <span className="muted">No temporary devices</span>
            </li>
          )}
        </ul>
      </section>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
