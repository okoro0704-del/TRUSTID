import { useEffect, useState, type FormEvent } from "react";
import type { AppLockPolicy, BiometricAvailability, LockedApp } from "@trustid/device-security";
import { DEFAULT_APP_LOCK_POLICY } from "@trustid/device-security";
import {
  getAppLockController,
  probeTier1Capabilities,
} from "../../lib/security/tier1";

const SUGGESTIONS: Omit<LockedApp, "addedAt">[] = [
  { packageId: "com.whatsapp", displayName: "WhatsApp" },
  { packageId: "com.google.android.apps.photos", displayName: "Google Photos" },
  { packageId: "com.android.gallery3d", displayName: "Gallery" },
  { packageId: "com.sec.android.gallery3d", displayName: "Samsung Gallery" },
  { packageId: "com.android.vending", displayName: "Play Store" },
];

export function AppLockerPage() {
  const [caps, setCaps] = useState<BiometricAvailability | null>(null);
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

  async function reload() {
    const ctrl = getAppLockController();
    setPolicy(await ctrl.getPolicy());
    setA11y(await ctrl.accessibilityStatus());
  }

  useEffect(() => {
    probeTier1Capabilities().then(setCaps).catch(() => undefined);
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
    const next = { ...policy, enabled: !policy.enabled };
    await persist(next);
  }

  async function togglePinFallback() {
    const next = {
      ...policy,
      allowDeviceCredential: !policy.allowDeviceCredential,
    };
    await persist(next);
  }

  async function addSuggestion(app: Omit<LockedApp, "addedAt">) {
    setBusy(true);
    setError(null);
    try {
      const next = await getAppLockController().addApp(app);
      setPolicy(next);
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
        <h2>App Locker</h2>
        <p className="sub">
          Intercept selected apps at launch and require a strong biometric before
          their UI is usable. Default policy refuses weak PIN fallback.
        </p>
        {caps && (
          <ul className="list compact-list">
            <li className="row">
              <span className="muted">Process shield</span>
              <span className={caps.appLockSupported ? "status-ok" : "status-off"}>
                {caps.appLockSupported ? "Android Accessibility" : "Not on this platform"}
              </span>
            </li>
          </ul>
        )}
        {a11y && <p className="muted">{a11y.note}</p>}
        <div className="inline-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={toggleEnabled}>
            {policy.enabled ? "Disable App Locker" : "Enable App Locker"}
          </button>
          {a11y?.supported && !a11y.enabled && (
            <button type="button" className="btn btn-ghost" onClick={openSettings}>
              Open Accessibility settings
            </button>
          )}
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={policy.allowDeviceCredential}
            disabled={busy}
            onChange={togglePinFallback}
          />
          <span>
            Allow device PIN / pattern fallback (off by default ù hardware
            biometric preferred)
          </span>
        </label>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="section surface-block">
        <h2>Protected apps</h2>
        <p className="sub">Android package names. Biometric required to change this list.</p>
        <ul className="list compact-list">
          {policy.apps.map((app) => (
            <li key={app.packageId} className="row">
              <div className="row-main">
                <strong>{app.displayName}</strong>
                <span className="muted tid">{app.packageId}</span>
              </div>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => removeApp(app.packageId)}
              >
                Remove
              </button>
            </li>
          ))}
          {policy.apps.length === 0 && (
            <li className="muted">No apps locked yet.</li>
          )}
        </ul>
      </section>

      <section className="section surface-block">
        <h2>Add apps</h2>
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
              <span className="muted">{s.packageId}</span>
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
              placeholder="com.example.bank"
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
          <button type="submit" className="btn btn-primary" disabled={busy || !customId.trim()}>
            Add package
          </button>
        </form>
      </section>
    </div>
  );
}
