import { useEffect, useState, type FormEvent } from "react";
import type { AppLockPolicy, LockedApp } from "@trustid/device-security";
import { DEFAULT_APP_LOCK_POLICY } from "@trustid/device-security";
import { getAppLockController } from "../../lib/security/tier1";

const SUGGESTIONS: Omit<LockedApp, "addedAt">[] = [
  { packageId: "com.whatsapp", displayName: "WhatsApp" },
  { packageId: "com.instagram.android", displayName: "Instagram" },
  { packageId: "com.google.android.apps.photos", displayName: "Google Photos" },
  { packageId: "com.android.gallery3d", displayName: "Gallery" },
  { packageId: "com.sec.android.gallery3d", displayName: "Samsung Gallery" },
  { packageId: "com.android.vending", displayName: "Play Store" },
];

/** Consumer Apps tab ? shows locked apps and App Locker controls. */
export function AppLockerPage() {
  const [policy, setPolicy] = useState<AppLockPolicy>({
    ...DEFAULT_APP_LOCK_POLICY,
    apps: [],
  });
  const [a11y, setA11y] = useState<{
    supported: boolean;
    enabled: boolean;
    note: string;
  } | null>(null);
  const [customId, setCustomId] = useState("");
  const [customName, setCustomName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function reload() {
    const ctrl = getAppLockController();
    setPolicy(await ctrl.getPolicy());
    setA11y(await ctrl.accessibilityStatus());
  }

  useEffect(() => {
    reload().catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load"),
    );
  }, []);

  async function persist(next: AppLockPolicy) {
    setBusy(true);
    setError(null);
    try {
      await getAppLockController().savePolicy(next);
      setPolicy(next);
      setA11y(await getAppLockController().accessibilityStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled() {
    await persist({ ...policy, enabled: !policy.enabled });
  }

  async function addSuggestion(app: Omit<LockedApp, "addedAt">) {
    setBusy(true);
    setError(null);
    try {
      const next = await getAppLockController().addApp(app);
      setPolicy(next);
      setShowAdd(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Add failed");
    } finally {
      setBusy(false);
    }
  }

  async function addCustom(e: FormEvent) {
    e.preventDefault();
    if (!customId.trim()) return;
    await addSuggestion({
      packageId: customId.trim(),
      displayName: customName.trim() || customId.trim(),
    });
    setCustomId("");
    setCustomName("");
  }

  async function removeApp(packageId: string) {
    setBusy(true);
    setError(null);
    try {
      setPolicy(await getAppLockController().removeApp(packageId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  }

  async function openSettings() {
    try {
      await getAppLockController().openNativeSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Settings unavailable");
    }
  }

  return (
    <div className="dashboard">
      <section className="section surface-block">
        <div className="section-head">
          <div>
            <h2>Locked apps</h2>
            <p className="sub">
              Apps you lock need Face ID, Touch ID, or fingerprint before they open.
            </p>
          </div>
          <button
            type="button"
            className={`btn ${policy.enabled ? "btn-ghost" : "btn-primary"}`}
            disabled={busy}
            onClick={toggleEnabled}
          >
            {policy.enabled ? "On" : "Turn on"}
          </button>
        </div>
        {a11y && <p className="muted">{a11y.note}</p>}
        {a11y?.supported && !a11y.enabled && (
          <button type="button" className="btn btn-ghost" onClick={openSettings}>
            Enable system App Lock
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="section surface-block">
        <div className="section-head">
          <h2>Your apps</h2>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => setShowAdd((v) => !v)}
          >
            {showAdd ? "Done" : "Lock an app"}
          </button>
        </div>

        {policy.apps.length === 0 ? (
          <p className="muted">No locked apps yet. Tap Lock an app to add one.</p>
        ) : (
          <ul className="list compact-list">
            {policy.apps.map((app) => (
              <li key={app.packageId} className="row">
                <div className="row-main">
                  <strong>{app.displayName}</strong>
                  <span className="muted">Requires biometric ? locked</span>
                </div>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => removeApp(app.packageId)}
                >
                  Unlock
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showAdd && (
        <section className="section surface-block">
          <h2>Add to App Locker</h2>
          <p className="sub">Pick a common app or enter a package name.</p>
          <div className="hub-grid">
            {SUGGESTIONS.filter(
              (s) => !policy.apps.some((a) => a.packageId === s.packageId),
            ).map((s) => (
              <button
                key={s.packageId}
                type="button"
                className="hub-card hub-card-btn"
                disabled={busy}
                onClick={() => addSuggestion(s)}
              >
                <strong>{s.displayName}</strong>
                <span className="muted">Lock with biometric</span>
              </button>
            ))}
          </div>
          <form className="stack-form" onSubmit={addCustom}>
            <div className="field">
              <label htmlFor="pkg">Package ID</label>
              <input
                id="pkg"
                value={customId}
                onChange={(e) => setCustomId(e.target.value)}
                placeholder="com.example.app"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor="pkgName">Display name</label>
              <input
                id="pkgName"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="My Bank"
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !customId.trim()}
            >
              Lock app
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
