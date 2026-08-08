import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { reauthenticate, prefetchReauth } from "../../lib/reauth";

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
  canEnroll?: boolean;
};

function trustLabel(level?: string) {
  if (level === "primary") return "Primary";
  if (level === "temporary") return "Temporary";
  return "Standard";
}

function useCountdown(expiresAt: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return "Expired";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remaining = useCountdown(enrollment?.expiresAt ?? null);

  async function load() {
    const d = await api<Device[]>("/devices");
    setDevices(d.filter((x) => x.trustLevel !== "temporary"));
  }

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load devices"),
    );
    prefetchReauth();
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
    setCopied(false);
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

  async function copyCode() {
    if (!enrollment?.pairingCode) return;
    try {
      await navigator.clipboard.writeText(enrollment.pairingCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy code");
    }
  }

  const spacedCode = useMemo(() => {
    const c = enrollment?.pairingCode ?? "";
    if (c.length !== 6) return c;
    return `${c.slice(0, 3)} ${c.slice(3)}`;
  }, [enrollment?.pairingCode]);

  return (
    <div className="dashboard">
      <section className="section surface-block">
        <h2>Sign in on another device</h2>
        <p className="sub">
          Generate a one-time code on this trusted device. Enter it on the new
          device to sign in — no new passkey needed. Your passkey stays here.
        </p>
        <form onSubmit={startEnrollment}>
          <button className="btn btn-primary" disabled={busy} type="submit">
            {busy ? "Generating…" : enrollment ? "Generate new code" : "Generate sign-in code"}
          </button>
        </form>
        {enrollment && (
          <div className="enroll-code-card" aria-live="polite">
            <p className="enroll-code-label">Show this code on the new device</p>
            <p className="enroll-code-value" data-testid="enrollment-code">
              {spacedCode}
            </p>
            <p className="enroll-code-meta">
              {remaining === "Expired" ? (
                <span className="error">Code expired — generate a new one</span>
              ) : (
                <span className="muted">Expires in {remaining}</span>
              )}
            </p>
            <div className="inline-actions" style={{ marginTop: "0.75rem" }}>
              <button className="btn btn-ghost" type="button" onClick={() => void copyCode()}>
                {copied ? "Copied" : "Copy code"}
              </button>
            </div>
            <ol className="enroll-steps">
              <li>On the new device, open TrustID</li>
              <li>
                Tap <strong>I have a device code</strong> (or open Enroll)
              </li>
              <li>Enter this code to sign in (no new passkey)</li>
            </ol>
            <p className="muted break-all" style={{ fontSize: "0.8rem" }}>
              Or open: {enrollment.joinUrl}
            </p>
          </div>
        )}
      </section>

      <section className="section">
        <h2>Trusted devices</h2>
        <p className="sub">
          Primary devices manage trust. See also{" "}
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
      {error && <p className="error">{error}</p>}
    </div>
  );
}
