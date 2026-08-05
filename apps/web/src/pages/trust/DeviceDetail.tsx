import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../lib/api";

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
  trustedAt: string;
  credentials: { id: string; displayName: string | null; status: string }[];
};

export function DeviceDetailPage() {
  const { id } = useParams();
  const [device, setDevice] = useState<Device | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api<Device>(`/devices/${id}`)
      .then(setDevice)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Not found"),
      );
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!device) return <p className="muted">Loading…</p>;

  return (
    <div className="dashboard">
      <section className="section">
        <Link className="muted" to="/dashboard/devices">
          ← Trusted devices
        </Link>
        <h2>{device.name}</h2>
        <p className="sub">
          {device.current ? "This is your current device." : "Trusted device details."}
        </p>
        <ul className="list">
          <li className="row">
            <span className="muted">Status</span>
            <span className={device.status === "active" ? "status-ok" : "status-off"}>
              {device.status}
            </span>
          </li>
          <li className="row">
            <span className="muted">Trust level</span>
            <span>{device.trustLevel ?? "standard"}</span>
          </li>
          <li className="row">
            <span className="muted">Platform</span>
            <span>{device.platform ?? device.deviceType ?? "—"}</span>
          </li>
          <li className="row">
            <span className="muted">Registered</span>
            <span>{new Date(device.trustedAt).toLocaleString()}</span>
          </li>
          <li className="row">
            <span className="muted">Last activity</span>
            <span>{device.lastActiveLabel}</span>
          </li>
          <li className="row">
            <span className="muted">User agent</span>
            <span className="muted" style={{ maxWidth: "50%", textAlign: "right" }}>
              {device.userAgent ?? "—"}
            </span>
          </li>
        </ul>
        <h3 style={{ fontSize: "1rem" }}>Passkeys on this device</h3>
        <ul className="list">
          {device.credentials.map((c) => (
            <li key={c.id} className="row">
              <span>{c.displayName ?? "Passkey"}</span>
              <span className="muted">{c.status}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
