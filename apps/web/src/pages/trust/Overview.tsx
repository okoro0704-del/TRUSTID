import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AppLockPolicy } from "@trustid/device-security";
import { DEFAULT_APP_LOCK_POLICY } from "@trustid/device-security";
import { getAppLockController, getMediaVault } from "../../lib/security/tier1";

export function OverviewPage() {
  const [lockedApps, setLockedApps] = useState(0);
  const [lockerOn, setLockerOn] = useState(false);
  const [mediaCount, setMediaCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      getAppLockController()
        .getPolicy()
        .catch(() => ({ ...DEFAULT_APP_LOCK_POLICY, apps: [] }) as AppLockPolicy),
      getMediaVault().sealedCount().catch(() => 0),
    ])
      .then(([policy, count]) => {
        setLockedApps(policy.apps.length);
        setLockerOn(policy.enabled);
        setMediaCount(count);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      );
  }, []);

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="dashboard home-dash">
      <section className="section surface-block">
        <p className="continue-eyebrow">TrustID</p>
        <h2>Keep apps and media private</h2>
        <p className="sub">
          Lock apps behind your biometric, and keep photos and videos in an
          encrypted private folder on this device.
        </p>
      </section>

      <section className="quick-grid consumer-quick">
        <Link className="quick-tile consumer-tile" to="/dashboard/apps">
          <span className="quick-value">{lockedApps}</span>
          <span className="quick-label">Locked apps</span>
          <span className="muted">{lockerOn ? "App Locker on" : "App Locker off"}</span>
        </Link>
        <Link className="quick-tile consumer-tile" to="/dashboard/media">
          <span className="quick-value">{mediaCount}</span>
          <span className="quick-label">Private media</span>
          <span className="muted">Biometric to open</span>
        </Link>
      </section>

      <section className="section surface-block">
        <h2>Get started</h2>
        <div className="action-rail">
          <Link className="action-chip" to="/dashboard/apps">
            Lock an app
          </Link>
          <Link className="action-chip" to="/dashboard/media">
            Add photos or video
          </Link>
          <Link className="action-chip" to="/dashboard/control">
            Logins & devices
          </Link>
          <Link className="action-chip" to="/dashboard/account">
            Account
          </Link>
        </div>
      </section>
    </div>
  );
}
