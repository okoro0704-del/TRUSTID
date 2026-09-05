import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  getBiometricAvailability,
  registerBiometricPasskey,
} from "../../lib/trustidBiometrics";
import {
  isMobileApp,
  setupTrustIDFingerprintStrict,
} from "../../lib/mobileBridge";
import { createTrustIdSdk } from "@trustid/sdk";

type EventRow = {
  id: string;
  type: string;
  createdAt: string;
};

type LoginRow = {
  id: string;
  time: string;
  result: string;
  method: string;
  application: string;
  deviceId: string | null;
};

type IdentityVerification = {
  status: string;
  verificationLevel: string;
  futureProvider: string;
  note: string;
};

const HUB = [
  { to: "/dashboard/vault", title: "Sovereign vault", blurb: "DAK/eSFS, app lock & duress" },
  { to: "/dashboard/media-vault", title: "Media vault (Tier 1)", blurb: "Encrypted photos & videos" },
  { to: "/dashboard/app-locker", title: "App locker", blurb: "Biometric process shield" },
  { to: "/dashboard/device-sync", title: "Device sync", blurb: "E2E blind relay (X3DH)" },
  { to: "/dashboard/guardians", title: "Recovery guardians", blurb: "Shamir threshold shares" },
  { to: "/dashboard/identity", title: "Verified identity", blurb: "Portrait & verification" },
  { to: "/dashboard/devices", title: "Trusted devices", blurb: "Primary & standard" },
  { to: "/dashboard/approvals", title: "Device approvals", blurb: "Pending requests" },
  { to: "/dashboard/passkeys", title: "Passkeys", blurb: "Credentials on device" },
  { to: "/dashboard/sessions", title: "Active sessions", blurb: "End unknown access" },
  { to: "/dashboard/temporary", title: "Temporary access", blurb: "Short-lived devices" },
  { to: "/dashboard/notifications", title: "Alerts", blurb: "Security notifications" },
  { to: "/dashboard/applications", title: "Connected apps", blurb: "Permissions & revoke" },
];

export function SecurityPage() {
  const { identity } = useAuth();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [logins, setLogins] = useState<LoginRow[]>([]);
  const [verification, setVerification] = useState<IdentityVerification | null>(
    null,
  );
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [bioBusy, setBioBusy] = useState(false);
  const [bioMessage, setBioMessage] = useState<string | null>(null);
  const [bioError, setBioError] = useState<string | null>(null);
  const [fpBusy, setFpBusy] = useState(false);
  const [fpMessage, setFpMessage] = useState<string | null>(null);
  const [fpError, setFpError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<EventRow[]>(
        `/security/events${filter ? `?type=${encodeURIComponent(filter)}` : ""}`,
      ),
      api<LoginRow[]>("/security/login-history"),
      api<IdentityVerification>("/account/identity-verification"),
    ])
      .then(([e, l, v]) => {
        setEvents(e);
        setLogins(l);
        setVerification(v);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      );
  }, [filter]);

  async function handleBiometricToggle() {
    setBioBusy(true);
    setBioError(null);
    setBioMessage(null);
    try {
      const avail = await getBiometricAvailability();
      if (!avail.available) {
        setBioError(
          avail.reason ??
            "Class 3 biometrics unavailable. Enable fingerprint / Face ID in settings.",
        );
        return;
      }
      const result = await registerBiometricPasskey({
        trustId: identity?.trustId,
      });
      if (!result.success) {
        setBioError(result.error || "Biometric enrollment failed. Please try again.");
        return;
      }
      setBioMessage("Hardware-backed TrustID passkey registered!");
    } catch (err) {
      setBioError(
        err instanceof Error ? err.message : "Biometric enrollment failed",
      );
    } finally {
      setBioBusy(false);
    }
  }

  /** Class 3 fingerprint setup — never crashes the app. */
  async function handleSetupFingerprint() {
    setFpBusy(true);
    setFpError(null);
    setFpMessage(null);
    try {
      if (!isMobileApp()) {
        setFpMessage(
          "Fingerprint hardware setup runs in the TrustID app. On web, use Setup biometrics / passkey.",
        );
        return;
      }

      const bound = await setupTrustIDFingerprintStrict(identity?.trustId);
      if (!bound.ok) {
        setFpError(
          bound.error ||
            "Could not complete fingerprint setup. Ensure fingerprints are registered in Android/iOS Settings.",
        );
        return;
      }

      if (bound.publicKeyBase64) {
        try {
          const { fingerprintPayloadFromPublicKey } = await import(
            "@trustid/sdk"
          );
          const payload = fingerprintPayloadFromPublicKey(bound.publicKeyBase64);
          const sdk = createTrustIdSdk({
            baseUrl: import.meta.env.VITE_API_URL ?? "/api",
          });
          await sdk.enrollBiometric(payload);
          setFpMessage(
            "Class 3 fingerprint bound to TrustID Keystore and saved as cloud backup.",
          );
          return;
        } catch (enrollErr) {
          console.warn("[TrustID] Cloud fingerprint enroll skipped:", enrollErr);
        }
      }

      setFpMessage(
        "Fingerprint successfully bound to TrustID Keystore (Class 3).",
      );
    } catch (error: unknown) {
      console.error("Handled Fingerprint Enrollment Exception:", error);
      setFpError(
        "Could not complete fingerprint setup. Please ensure fingerprints are registered in Android/iOS Settings.",
      );
    } finally {
      setFpBusy(false);
    }
  }

  return (
    <div className="dashboard">
      <section className="section surface-block">
        <h2>Hardware biometrics</h2>
        <p className="sub">
          Class 3 only (fingerprint sensor or 3D Face ID). 2D camera face unlock
          is rejected. Canceling shows an inline error — the app will not quit.
        </p>
        <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={bioBusy || !identity?.trustId}
            onClick={() => void handleBiometricToggle()}
          >
            {bioBusy ? "Waiting for authenticator…" : "Setup biometrics / passkey"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={fpBusy || !identity?.trustId}
            onClick={() => void handleSetupFingerprint()}
          >
            {fpBusy ? "Waiting for fingerprint…" : "Setup Fingerprint"}
          </button>
        </div>
        {bioMessage && <p className="notice">{bioMessage}</p>}
        {bioError && <p className="error">{bioError}</p>}
        {fpMessage && <p className="notice">{fpMessage}</p>}
        {fpError && <p className="error">{fpError}</p>}
      </section>

      <section className="section surface-block">
        <h2>Security hub</h2>
        <p className="sub">
          Device privacy controls and identity trust — media vault, app locker,
          passkeys, sessions, and assurance.
        </p>
        <div className="hub-grid">
          {HUB.map((item) => (
            <Link key={item.to} className="hub-card" to={item.to}>
              <strong>{item.title}</strong>
              <span className="muted">{item.blurb}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="section surface-block">
        <h2>Identity verification</h2>
        <p className="sub">Future capability — not government verified today.</p>
        {verification && (
          <ul className="list compact-list">
            <li className="row">
              <span className="muted">Status</span>
              <span>{verification.status}</span>
            </li>
            <li className="row">
              <span className="muted">Verification level</span>
              <span>{verification.verificationLevel}</span>
            </li>
            <li className="row">
              <span className="muted">Future provider</span>
              <span>{verification.futureProvider}</span>
            </li>
          </ul>
        )}
        <p className="muted">{verification?.note}</p>
      </section>

      <section className="section surface-block">
        <h2>Login history</h2>
        <p className="sub">Read-only authentication history.</p>
        <ul className="list compact-list">
          {logins.slice(0, 8).map((l) => (
            <li key={l.id} className="row">
              <div className="row-main">
                <strong>{l.result}</strong>
                <span className="muted">
                  {l.method} · {l.application}
                </span>
              </div>
              <span className="muted">{new Date(l.time).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="section surface-block">
        <h2>Security events</h2>
        <div className="field">
          <label htmlFor="filter">Filter by event type</label>
          <input
            id="filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="e.g. device.revoked"
          />
        </div>
        <ul className="list compact-list">
          {events.slice(0, 12).map((ev) => (
            <li key={ev.id} className="row">
              <span className="event-type">{ev.type}</span>
              <span className="muted">{new Date(ev.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="section surface-block">
        <h2>Recovery methods</h2>
        <p className="muted">Placeholder — high-assurance recovery comes later.</p>
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
