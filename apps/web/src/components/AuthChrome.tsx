import { Link } from "react-router-dom";
import type { ReactNode } from "react";

/** Shared chrome for auth / onboarding screens — phone-app feel without bottom tabs. */
export function AuthChrome({
  children,
  backTo = "/",
  title = "TrustID",
}: {
  children: ReactNode;
  backTo?: string;
  title?: string;
}) {
  return (
    <div className="app-frame auth-frame">
      <div className="app-ambient" aria-hidden="true" />
      <header className="app-topbar">
        <div className="app-topbar-inner">
          <Link to={backTo} className="app-topbar-brand">
            <span className="app-mark" aria-hidden="true" />
            <div>
              <div className="app-topbar-title">{title}</div>
              <div className="app-topbar-sub">Secure identity</div>
            </div>
          </Link>
          <div className="app-seal" title="Cryptographic trust">
            <span className="app-seal-ring" />
            <span className="app-seal-core" />
          </div>
        </div>
      </header>
      <main className="app-content auth-content">{children}</main>
    </div>
  );
}
