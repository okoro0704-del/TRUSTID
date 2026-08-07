import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

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
    to: "/dashboard/devices",
    label: "Devices",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect
          x="7"
          y="3.5"
          width="10"
          height="17"
          rx="2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <path d="M11 18.5h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: "/dashboard/security",
    label: "Security",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 3.5 19 6.5v5.2c0 4.2-2.7 7.9-7 9.3-4.3-1.4-7-5.1-7-9.3V6.5L12 3.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="m9.2 12.1 1.9 1.9 3.7-3.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    to: "/dashboard/applications",
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

const TITLES: Record<string, string> = {
  "/dashboard": "Trust Center",
  "/dashboard/devices": "Devices",
  "/dashboard/approvals": "Approvals",
  "/dashboard/temporary": "Temporary",
  "/dashboard/applications": "Apps",
  "/dashboard/sessions": "Sessions",
  "/dashboard/passkeys": "Passkeys",
  "/dashboard/notifications": "Alerts",
  "/dashboard/security": "Security",
  "/dashboard/account": "Account",
};

function titleFor(pathname: string) {
  if (pathname.startsWith("/dashboard/devices/")) return "Device";
  return TITLES[pathname] ?? "TrustID";
}

export function TrustCenterLayout() {
  const { identity, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const title = titleFor(location.pathname);

  async function onLogout() {
    await logout();
    navigate("/");
  }

  return (
    <div className="app-frame">
      <div className="app-ambient" aria-hidden="true" />
      <header className="app-topbar">
        <div className="app-topbar-inner">
          <div className="app-topbar-brand">
            <span className="app-mark" aria-hidden="true" />
            <div>
              <div className="app-topbar-title">{title}</div>
              <div className="app-topbar-sub">
                {identity?.trustId ?? "Identity & trust"}
              </div>
            </div>
          </div>
          <div className="app-topbar-actions">
            <NavLink
              to="/dashboard/notifications"
              className="app-icon-btn"
              aria-label="Security alerts"
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
            <button
              className="app-icon-btn"
              type="button"
              onClick={onLogout}
              aria-label="Sign out"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M10 5.5H7.5A2 2 0 0 0 5.5 7.5v9a2 2 0 0 0 2 2H10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
                <path
                  d="M13.5 12H20m0 0-2.5-2.5M20 12l-2.5 2.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
        {identity && (
          <div className="app-trust-strip">
            <span className="app-pulse" aria-hidden="true" />
            <span className="app-trust-strip-text">
              {identity.profile?.name ?? "Trusted identity"} · session active
            </span>
          </div>
        )}
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
