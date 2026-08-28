import { useEffect, useState, type FormEvent } from "react";
import type { AppLockPolicy, LockedApp } from "@trustid/device-security";
import { DEFAULT_APP_LOCK_POLICY } from "@trustid/device-security";
import { getAppLockController } from "../../lib/security/tier1";

const SUGGESTIONS: Omit<LockedApp, "addedAt">[] = [
  { packageId: "com.whatsapp", displayName: "WhatsApp" },
  { packageId: "com.instagram.android", displayName: "Instagram" },
  { packageId: "com.snapchat.android", displayName: "Snapchat" },
  { packageId: "com.google.android.apps.photos", displayName: "Google Photos" },
  { packageId: "com.android.gallery3d", displayName: "Gallery" },
  { packageId: "com.sec.android.gallery3d", displayName: "Samsung Gallery" },
  { packageId: "com.android.vending", displayName: "Play Store" },
  { packageId: "com.twitter.android", displayName: "X" },
];

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/** 2026 App Locker ? locked app tiles with biometric shield. */
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
    <div className="dashboard locker-shell">
      <section className="locker-hero">
        <p className="locker-eyebrow">App Locker</p>
        <h1 className="locker-title">Protected apps</h1>
        <p className="locker-lede">
          Locked apps open only after biometric. Your shield stays on until you
          turn it off.
        </p>

        <div className="locker-switch-card">
          <div>
            <strong>App Lock shield</strong>
            <span className="muted">
              {policy.enabled
                ? `${policy.apps.length} app${policy.apps.length === 1 ? "" : "s"} protected`
                : "Off ? apps open freely"}
            </span>
          </div>
          <button
            type="button"
            className={`locker-switch ${policy.enabled ? "on" : ""}`}
            disabled={busy}
            aria-pressed={policy.enabled}
            onClick={toggleEnabled}
          >
            <span className="locker-switch-knob" />
          </button>
        </div>

        {a11y && <p className="muted locker-note">{a11y.note}</p>}
        {a11y?.supported && !a11y.enabled && (
          <button type="button" className="btn btn-ghost" onClick={openSettings}>
            Enable system App Lock
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="locker-toolbar">
        <h2 className="locker-title-sm">Your locker</h2>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => setShowAdd((v) => !v)}
        >
          {showAdd ? "Done" : "Add app"}
        </button>
      </section>

      {policy.apps.length === 0 ? (
        <section className="locker-empty">
          <p>No apps locked</p>
          <span className="muted">Add WhatsApp, Gallery, or any package.</span>
        </section>
      ) : (
        <div className="app-lock-grid">
          {policy.apps.map((app) => (
            <article key={app.packageId} className="app-lock-tile">
              <div className="app-lock-icon" aria-hidden="true">
                {initials(app.displayName) || "App"}
                <span className="app-lock-badge">
                  <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                    <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
                    <path
                      d="M5 7V5a3 3 0 0 1 6 0v2"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                    />
                  </svg>
                </span>
              </div>
              <strong>{app.displayName}</strong>
              <span className="muted">Biometric required</span>
              <button
                type="button"
                className="btn btn-ghost app-lock-remove"
                disabled={busy}
                onClick={() => removeApp(app.packageId)}
              >
                Remove
              </button>
            </article>
          ))}
        </div>
      )}

      {showAdd && (
        <section className="locker-add-sheet">
          <h2 className="locker-title-sm">Lock an app</h2>
          <div className="app-lock-grid app-lock-grid-suggest">
            {SUGGESTIONS.filter(
              (s) => !policy.apps.some((a) => a.packageId === s.packageId),
            ).map((s) => (
              <button
                key={s.packageId}
                type="button"
                className="app-lock-tile app-lock-tile-btn"
                disabled={busy}
                onClick={() => addSuggestion(s)}
              >
                <div className="app-lock-icon" aria-hidden="true">
                  {initials(s.displayName)}
                </div>
                <strong>{s.displayName}</strong>
                <span className="muted">Tap to lock</span>
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
