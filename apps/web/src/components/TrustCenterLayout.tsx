import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

const NAV = [
  { to: "/dashboard", label: "Overview", end: true },
  { to: "/dashboard/devices", label: "Devices" },
  { to: "/dashboard/approvals", label: "Approvals" },
  { to: "/dashboard/temporary", label: "Temporary" },
  { to: "/dashboard/applications", label: "Apps" },
  { to: "/dashboard/sessions", label: "Sessions" },
  { to: "/dashboard/passkeys", label: "Passkeys" },
  { to: "/dashboard/notifications", label: "Alerts" },
  { to: "/dashboard/security", label: "Security" },
  { to: "/dashboard/account", label: "Account" },
];

export function TrustCenterLayout() {
  const { identity, logout } = useAuth();
  const navigate = useNavigate();

  async function onLogout() {
    await logout();
    navigate("/");
  }

  return (
    <div className="shell trust-shell">
      <header className="trust-header">
        <div className="trust-header-top">
          <div>
            <div className="brand">TrustID</div>
            <p className="muted trust-header-sub">Identity & Trust Center</p>
          </div>
          <button className="btn btn-ghost" type="button" onClick={onLogout}>
            Sign out
          </button>
        </div>
        {identity && (
          <div className="trust-id-chip">
            <span className="tid">{identity.trustId}</span>
            <span className="muted">{identity.profile?.name}</span>
          </div>
        )}
        <nav className="trust-nav" aria-label="Trust Center">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                isActive ? "trust-nav-link active" : "trust-nav-link"
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
