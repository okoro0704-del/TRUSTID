import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createTrustIdSdk } from "@trustid/sdk";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { captureFingerprintBackup } from "../../lib/ambientCapture";
import { clearRememberedAccount } from "../../lib/rememberedAccount";
import { useTopbarIdentity } from "../../lib/useTopbarIdentity";

type Prefs = {
  profile: { firstName: string; lastName: string } | null;
  theme: string;
  notificationsEnabled: boolean;
  privacyShareAnalytics: boolean;
  language: string;
};

const LINKS = [
  { to: "/dashboard/identity", label: "Identity" },
  { to: "/dashboard/devices", label: "Devices" },
  { to: "/dashboard/passkeys", label: "Passkeys" },
  { to: "/dashboard/approvals", label: "Approvals" },
  { to: "/dashboard/applications", label: "Connected apps" },
  { to: "/dashboard/sessions", label: "Sessions" },
  { to: "/dashboard/notifications", label: "Alerts" },
];

export function AccountPage() {
  const { identity, logout } = useAuth();
  const { portraitUrl } = useTopbarIdentity();
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [fpBusy, setFpBusy] = useState(false);
  const [fpMessage, setFpMessage] = useState<string | null>(null);

  useEffect(() => {
    api<Prefs>("/account/preferences")
      .then(setPrefs)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      );
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!prefs) return;
    setMessage(null);
    setError(null);
    try {
      const updated = await api<Prefs>("/account/preferences", {
        method: "PATCH",
        body: JSON.stringify({
          firstName: prefs.profile?.firstName,
          lastName: prefs.profile?.lastName,
          theme: prefs.theme,
          notificationsEnabled: prefs.notificationsEnabled,
          privacyShareAnalytics: prefs.privacyShareAnalytics,
          language: prefs.language,
        }),
      });
      setPrefs((prev) =>
        prev
          ? {
              ...prev,
              theme: updated.theme,
              notificationsEnabled: updated.notificationsEnabled,
              privacyShareAnalytics: updated.privacyShareAnalytics,
              language: updated.language,
            }
          : prev,
      );
      setMessage("Preferences saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function onRegisterFingerprint() {
    setFpBusy(true);
    setFpMessage(null);
    setError(null);
    try {
      const fp = await captureFingerprintBackup(
        "Scan your fingerprint to save a Trust ID backup",
      );
      if (!fp) {
        setFpMessage("Fingerprint capture cancelled or unavailable on this device.");
        return;
      }
      const sdk = createTrustIdSdk({
        baseUrl: import.meta.env.VITE_API_URL ?? "/api",
      });
      await sdk.enrollBiometric(fp);
      setFpMessage("Fingerprint backup saved to your Trust ID cloud registry.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fingerprint registration failed");
    } finally {
      setFpBusy(false);
    }
  }

  async function onLogout() {
    setLoggingOut(true);
    setError(null);
    try {
      clearRememberedAccount();
      try {
        sessionStorage.setItem("trustid.explicitLogout", "1");
      } catch {
        /* ignore */
      }
      await logout();
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign out failed");
      setLoggingOut(false);
    }
  }

  const displayName =
    [prefs?.profile?.firstName, prefs?.profile?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    identity?.profile?.name ||
    identity?.trustId ||
    "Trust ID";

  const initials =
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "TI";

  return (
    <div className="dashboard account-page">
      <section className="account-hero">
        <div className="account-avatar-wrap">
          {portraitUrl ? (
            <img
              className="account-avatar"
              src={portraitUrl}
              alt=""
              width={96}
              height={96}
            />
          ) : (
            <span className="account-avatar account-avatar-fallback" aria-hidden="true">
              {initials}
            </span>
          )}
          {portraitUrl && <span className="account-avatar-verified" aria-hidden="true" />}
        </div>
        <h1 className="account-name">{displayName}</h1>
        <p className="account-trustid">{identity?.trustId ?? "—"}</p>
        <Link className="btn btn-ghost account-photo-link" to="/dashboard/identity">
          Profile photo & identity
        </Link>
      </section>

      <section className="section account-under-photo">
        <h2>Preferences</h2>
        {!prefs ? (
          <p className="muted">Loading…</p>
        ) : (
          <form className="panel account-prefs" onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="firstName">First name</label>
              <input
                id="firstName"
                value={prefs.profile?.firstName ?? ""}
                onChange={(e) =>
                  setPrefs({
                    ...prefs,
                    profile: {
                      firstName: e.target.value,
                      lastName: prefs.profile?.lastName ?? "",
                    },
                  })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="lastName">Last name</label>
              <input
                id="lastName"
                value={prefs.profile?.lastName ?? ""}
                onChange={(e) =>
                  setPrefs({
                    ...prefs,
                    profile: {
                      firstName: prefs.profile?.firstName ?? "",
                      lastName: e.target.value,
                    },
                  })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="theme">Theme</label>
              <select
                id="theme"
                value={prefs.theme}
                onChange={(e) => setPrefs({ ...prefs, theme: e.target.value })}
              >
                <option value="system">System</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>
            <label className="account-check">
              <input
                type="checkbox"
                checked={prefs.notificationsEnabled}
                onChange={(e) =>
                  setPrefs({ ...prefs, notificationsEnabled: e.target.checked })
                }
              />
              Security notifications
            </label>
            <label className="account-check">
              <input
                type="checkbox"
                checked={prefs.privacyShareAnalytics}
                onChange={(e) =>
                  setPrefs({ ...prefs, privacyShareAnalytics: e.target.checked })
                }
              />
              Share anonymous product analytics
            </label>
            <button className="btn btn-primary" type="submit">
              Save
            </button>
            {message && <p className="notice">{message}</p>}
          </form>
        )}
      </section>

      <section className="section account-under-photo">
        <h2>Biometric backup</h2>
        <p className="sub">
          Face is your portable Trust ID across web, PWA, and the Android app
          (one face template per person). Fingerprint is an optional backup on
          this device when the camera cannot match you.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          disabled={fpBusy}
          onClick={() => void onRegisterFingerprint()}
        >
          {fpBusy ? "Waiting for fingerprint…" : "Register fingerprint backup"}
        </button>
        {fpMessage && <p className="notice">{fpMessage}</p>}
      </section>

      <section className="section account-under-photo">
        <h2>More</h2>
        <div className="account-link-list">
          {LINKS.map((item) => (
            <Link key={item.to} className="account-link-row" to={item.to}>
              <span>{item.label}</span>
              <span aria-hidden="true">›</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="section account-under-photo">
        <button
          type="button"
          className="btn btn-ghost account-logout"
          disabled={loggingOut}
          onClick={() => void onLogout()}
        >
          {loggingOut ? "Signing out…" : "Sign out"}
        </button>
        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}
