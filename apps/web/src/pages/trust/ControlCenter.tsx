import { Link } from "react-router-dom";

const CONTROLS = [
  {
    to: "/dashboard/devices",
    title: "Devices",
    blurb: "Phones and computers you trust",
  },
  {
    to: "/dashboard/sessions",
    title: "Logins & sessions",
    blurb: "Active sign-ins across apps",
  },
  {
    to: "/dashboard/passkeys",
    title: "Passkeys",
    blurb: "Face ID / fingerprint credentials",
  },
  {
    to: "/dashboard/applications",
    title: "Connected apps",
    blurb: "Apps using your TrustID",
  },
  {
    to: "/dashboard/approvals",
    title: "Approvals",
    blurb: "New device requests",
  },
  {
    to: "/dashboard/temporary",
    title: "Temporary access",
    blurb: "Short-lived device access",
  },
  {
    to: "/dashboard/notifications",
    title: "Alerts",
    blurb: "Security notifications",
  },
  {
    to: "/dashboard/identity",
    title: "Verified identity",
    blurb: "Portrait used as your profile photo",
  },
];

/** Hub for logins, devices, and TrustID consumption controls. */
export function ControlCenterPage() {
  return (
    <div className="dashboard locker-shell">
      <section className="locker-hero">
        <p className="locker-eyebrow">Control</p>
        <h1 className="locker-title">Logins & devices</h1>
        <p className="locker-lede">
          Manage every place TrustID signs you in — devices, sessions, passkeys,
          and apps that use your verified profile.
        </p>
      </section>

      <section className="control-list" aria-label="Control center">
        {CONTROLS.map((item) => (
          <Link key={item.to} to={item.to} className="control-row">
            <div className="control-row-copy">
              <strong>{item.title}</strong>
              <span>{item.blurb}</span>
            </div>
            <span className="control-chevron" aria-hidden="true">
              ›
            </span>
          </Link>
        ))}
      </section>
    </div>
  );
}
