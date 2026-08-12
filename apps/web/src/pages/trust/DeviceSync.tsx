import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  fetchSyncDevices,
  publishDevicePrekeys,
} from "../../lib/security/sovereign";

type DeviceRow = {
  id: string;
  name: string;
  trustLevel: string;
  hasPrekeyBundle: boolean;
  status: string;
};

export function DeviceSyncPage() {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [selected, setSelected] = useState("");
  const [inbox, setInbox] = useState<unknown[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function reload() {
    setDevices(await fetchSyncDevices());
  }

  useEffect(() => {
    reload().catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load"),
    );
  }, []);

  async function onPublish() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await publishDevicePrekeys(selected);
      setNote("Published X3DH public prekey bundle. Private keys stay on this device.");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setBusy(false);
    }
  }

  async function onInbox() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ envelopes: unknown[] }>(`/sync/inbox/${selected}`);
      setInbox(res.envelopes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Inbox failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dashboard">
      <section className="section surface-block">
        <h2>Encrypted device sync</h2>
        <p className="sub">
          X3DH-inspired end-to-end channel. TrustID relays opaque ciphertext only —
          session keys and vault metadata never hit the server in plaintext.
        </p>
        <div className="field">
          <label htmlFor="sync-device">This device</label>
          <select
            id="sync-device"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Select device…</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.trustLevel})
                {d.hasPrekeyBundle ? " · prekeys ready" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="inline-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !selected}
            onClick={onPublish}
          >
            Publish prekeys
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || !selected}
            onClick={onInbox}
          >
            Check sync inbox
          </button>
        </div>
        {note && <p className="muted">{note}</p>}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="section surface-block">
        <h2>Paired devices</h2>
        <ul className="list compact-list">
          {devices.map((d) => (
            <li key={d.id} className="row">
              <div className="row-main">
                <strong>{d.name}</strong>
                <span className="muted">
                  {d.trustLevel} · {d.hasPrekeyBundle ? "bundle published" : "no bundle"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {inbox.length > 0 && (
        <section className="section surface-block">
          <h2>Pending envelopes</h2>
          <p className="sub">{inbox.length} sealed message(s) waiting — decrypt locally after X3DH.</p>
          <pre className="code-block">{JSON.stringify(inbox, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
