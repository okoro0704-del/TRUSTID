import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";

type Prefs = {
  profile: { firstName: string; lastName: string } | null;
  theme: string;
  notificationsEnabled: boolean;
  privacyShareAnalytics: boolean;
  language: string;
};

export function AccountPage() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (!prefs) return <p className="muted">Loading…</p>;

  return (
    <div className="dashboard">
      <section className="section">
        <h2>Account</h2>
        <p className="sub">Profile and privacy preferences.</p>
        <form className="panel" style={{ width: "100%" }} onSubmit={onSubmit}>
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
              style={{
                background: "rgba(7,30,28,0.55)",
                border: "1px solid var(--line)",
                borderRadius: 12,
                color: "var(--foam)",
                padding: "0.8rem 0.9rem",
              }}
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <label className="muted">
            <input
              type="checkbox"
              checked={prefs.notificationsEnabled}
              onChange={(e) =>
                setPrefs({ ...prefs, notificationsEnabled: e.target.checked })
              }
            />{" "}
            Security notifications
          </label>
          <label className="muted">
            <input
              type="checkbox"
              checked={prefs.privacyShareAnalytics}
              onChange={(e) =>
                setPrefs({ ...prefs, privacyShareAnalytics: e.target.checked })
              }
            />{" "}
            Share anonymous product analytics
          </label>
          <button className="btn btn-primary" type="submit">
            Save
          </button>
          {message && <p className="notice">{message}</p>}
          {error && <p className="error">{error}</p>}
        </form>
      </section>
    </div>
  );
}
