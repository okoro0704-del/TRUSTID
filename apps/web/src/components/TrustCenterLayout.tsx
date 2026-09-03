import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { MasterDeviceApprovalListener } from "@trustid/ui-react";
import { useAuth } from "../lib/auth";
import { useTopbarIdentity } from "../lib/useTopbarIdentity";
import { reauthenticate } from "../lib/reauth";

const TABS = [
  {
    to: "/dashboard",
    end: true,
    label: "Home",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M4.5 10.5 12 4l7.5 6.5V20a1 1 0 0 1-1 1h-4.5v-5.5h-4V21H5.5a1 1 0 0 1-1-1v-9.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    to: "/dashboard/apps",
    label: "Apps",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="4" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <rect x="13" y="4" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <rect x="4" y="13" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <rect x="13" y="13" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    ),
  },
  {
    to: "/dashboard/media",
    label: "Media",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M5 7.5A2.5 2.5 0 0 1 7.5 5h3l1.2 1.5H16.5A2.5 2.5 0 0 1 19 9v8a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 17V7.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="13" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    ),
  },
  {
    to: "/dashboard/control",
    label: "Control",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6.1 6.1l1.6 1.6M16.3 16.3l1.6 1.6M17.9 6.1l-1.6 1.6M7.7 16.3l-1.6 1.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    to: "/dashboard/account",
    label: "Account",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8.5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M5.5 19.2c1.6-3 4-4.5 6.5-4.5s4.9 1.5 6.5 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

const PRIMARY_TAB_PATHS = new Set(TABS.map((t) => t.to));

const TITLES: Record<string, string> = {
  "/dashboard": "TrustID",
  "/dashboard/apps": "App Locker",
  "/dashboard/app-locker": "App Locker",
  "/dashboard/media": "Media Locker",
  "/dashboard/media-vault": "Media Locker",
  "/dashboard/control": "Control",
  "/dashboard/security": "Media Locker",
  "/dashboard/devices": "Devices",
  "/dashboard/approvals": "Approvals",
  "/dashboard/temporary": "Temporary",
  "/dashboard/applications": "Connected apps",
  "/dashboard/sessions": "Sessions",
  "/dashboard/passkeys": "Passkeys",
  "/dashboard/notifications": "Alerts",
  "/dashboard/vault": "Vault",
  "/dashboard/device-sync": "Device Sync",
  "/dashboard/guardians": "Guardians",
  "/dashboard/identity": "Identity",
  "/dashboard/account": "Account",
};

function titleFor(pathname: string) {
  if (pathname.startsWith("/dashboard/devices/")) return "Device";
  return TITLES[pathname] ?? "TrustID";
}

function isPrimaryTab(pathname: string) {
  if (PRIMARY_TAB_PATHS.has(pathname)) return true;
  // Exact home only for /dashboard — nested never matches set without end
  return false;
}

export function TrustCenterLayout() {
  const { identity } = useAuth();
  const { portraitUrl } = useTopbarIdentity();
  const navigate = useNavigate();
  const location = useLocation();
  const title = titleFor(location.pathname);
  const onHome = location.pathname === "/dashboard";
  const onPrimaryTab = isPrimaryTab(location.pathname);
  const showBack = !onHome && !onPrimaryTab;

  const initials =
    identity?.profile?.name
      ?.split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "TI";

  return (
    <div className="app-frame">
      <MasterDeviceApprovalListener reauthenticate={reauthenticate} />
      <div className="app-ambient" aria-hidden="true" />
      <header className={`app-topbar ${onPrimaryTab ? "app-topbar-centered" : ""}`}>
        <div className="app-topbar-inner">
          <div className="app-topbar-side app-topbar-side-left">
            {showBack ? (
              <button
                type="button"
                className="app-icon-btn"
                aria-label="Go back"
                onClick={() => {
                  if (window.history.length > 1) navigate(-1);
                  else navigate("/dashboard");
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M15 5.5 8.5 12 15 18.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : (
              <span className="app-topbar-spacer" aria-hidden="true" />
            )}
          </div>

          <div className="app-topbar-center">
            <div className="app-topbar-title">{title}</div>
            {!onPrimaryTab && (
              <div className="app-topbar-sub">
                {identity?.trustId ?? "Private & locked"}
              </div>
            )}
          </div>

          <div className="app-topbar-side app-topbar-side-right">
            <NavLink
              to="/dashboard/notifications"
              className="app-icon-btn"
              aria-label="Alerts"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M6.5 16.5h11l-1.2-1.4V11a4.3 4.3 0 1 0-8.6 0v4.1L6.5 16.5Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                <path
                  d="M10 18.2a2 2 0 0 0 4 0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </NavLink>
            <NavLink
              to="/dashboard/account"
              className="app-avatar-link app-avatar-link-right"
              aria-label="Account"
              title="Account"
            >
              {portraitUrl ? (
                <img
                  className="app-avatar app-avatar-lg"
                  src={portraitUrl}
                  alt=""
                  width={40}
                  height={40}
                />
              ) : (
                <span className="app-avatar app-avatar-lg app-avatar-fallback" aria-hidden="true">
                  {initials}
                </span>
              )}
              {portraitUrl && (
                <span className="app-avatar-verified" aria-hidden="true" />
              )}
            </NavLink>
          </div>
        </div>
      </header>

      <main className="app-content">
        <Outlet />
      </main>

      <nav className="app-tabbar" aria-label="Primary">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              isActive ? "app-tab active" : "app-tab"
            }
          >
            <span className="app-tab-icon">{tab.icon}</span>
            <span className="app-tab-label">{tab.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
