import { useEffect, useState } from "react";
import { api } from "../../lib/api";

type Passkey = {
  id: string;
  displayName: string;
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
  authenticatorAttachment: string | null;
  device: { id: string; name: string; status: string };
};

export function PasskeysPage() {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setPasskeys(await api<Passkey[]>("/passkeys"));
  }

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load"),
    );
  }, []);

  async function rename(id: string, name: string) {
    const next = window.prompt("Passkey name", name);
    if (!next?.trim()) return;
    await api(`/passkeys/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: next.trim() }),
    });
    await load();
  }

  async function remove(id: string) {
    if (!window.confirm("Remove this passkey?")) return;
    try {
      await api(`/passkeys/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove passkey");
    }
  }

  return (
    <div className="dashboard">
      <section className="section">
        <h2>Passkeys</h2>
        <p className="sub">
          Public credentials only. Private keys never leave your device. Keep at
          least one valid authentication method.
        </p>
        <ul className="list">
          {passkeys.map((p) => (
            <li key={p.id} className="row">
              <div className="row-main">
                <strong>{p.displayName}</strong>
                <span className={p.status === "active" ? "status-ok" : "status-off"}>
                  {p.status}
                </span>
                <span className="muted">
                  Device: {p.device.name} · {p.authenticatorAttachment ?? "platform"}
                </span>
                <span className="muted">
                  Created {new Date(p.createdAt).toLocaleDateString()}
                  {p.lastUsedAt
                    ? ` · Last used ${new Date(p.lastUsedAt).toLocaleString()}`
                    : ""}
                </span>
              </div>
              {p.status === "active" && (
                <div className="inline-actions">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => rename(p.id, p.displayName)}
                  >
                    Rename
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    onClick={() => remove(p.id)}
                  >
                    Remove
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
