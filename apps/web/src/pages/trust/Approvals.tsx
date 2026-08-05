import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { reauthenticate } from "../../lib/reauth";
import { ApproveDeviceDialog } from "../../components/ApproveDeviceDialog";

type Approval = {
  id: string;
  status: string;
  applicationName: string;
  deviceName: string;
  platform: string | null;
  browser: string | null;
  location: string | null;
  createdAt: string;
  expiresAt: string;
};

export function ApprovalsPage() {
  const [pending, setPending] = useState<Approval[]>([]);
  const [history, setHistory] = useState<Approval[]>([]);
  const [selected, setSelected] = useState<Approval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [p, all] = await Promise.all([
      api<Approval[]>("/device-approvals/pending"),
      api<Approval[]>("/device-approvals"),
    ]);
    setPending(p);
    setHistory(all.filter((a) => a.status !== "pending"));
  }

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load"),
    );
    const t = setInterval(() => {
      load().catch(() => undefined);
    }, 4000);
    return () => clearInterval(t);
  }, []);

  async function act(action: "approve" | "temporary" | "decline") {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const response = await reauthenticate();
      const path =
        action === "approve"
          ? `/device-approvals/${selected.id}/approve`
          : action === "temporary"
            ? `/device-approvals/${selected.id}/temporary`
            : `/device-approvals/${selected.id}/decline`;
      await api(path, {
        method: "POST",
        body: JSON.stringify({ response }),
      });
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dashboard">
      <section className="section">
        <h2>Device approval requests</h2>
        <p className="sub">
          Only primary trusted devices can approve. Local verification is
          required for every decision.
        </p>
        {pending.length === 0 ? (
          <p className="muted">No pending requests</p>
        ) : (
          <ul className="list">
            {pending.map((r) => (
              <li key={r.id} className="row">
                <div className="row-main">
                  <strong>{r.deviceName}</strong>
                  <span className="muted">
                    {r.applicationName} · {r.browser ?? "Browser"} ·{" "}
                    {r.platform ?? "Platform unknown"}
                  </span>
                  <span className="muted">
                    {r.location ?? "Location unavailable"} ·{" "}
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </div>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => setSelected(r)}
                >
                  Review
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <h2>Recent decisions</h2>
        <ul className="list">
          {history.slice(0, 10).map((r) => (
            <li key={r.id} className="row">
              <div className="row-main">
                <strong>{r.deviceName}</strong>
                <span className="muted">{r.status}</span>
              </div>
              <span className="muted">
                {new Date(r.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {selected && (
        <ApproveDeviceDialog
          request={selected}
          busy={busy}
          onClose={() => setSelected(null)}
          onTrust={() => act("approve")}
          onTemporary={() => act("temporary")}
          onDecline={() => act("decline")}
        />
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
