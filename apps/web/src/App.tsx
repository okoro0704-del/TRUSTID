import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { WelcomePage } from "./pages/Welcome";
import { RegisterPage } from "./pages/Register";
import { VerifyPage } from "./pages/Verify";
import { SecurePage } from "./pages/Secure";
import { SecuredPage } from "./pages/Secured";
import { ContinuePage } from "./pages/Continue";
import { DashboardPage } from "./pages/Dashboard";
import { ConsentPage } from "./pages/Consent";

function Guard({ children }: { children: React.ReactNode }) {
  const { loading, identity } = useAuth();
  if (loading) return <div className="shell muted">Loading…</div>;
  if (!identity) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<WelcomePage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/verify" element={<VerifyPage />} />
      <Route path="/secure" element={<SecurePage />} />
      <Route
        path="/secured"
        element={
          <Guard>
            <SecuredPage />
          </Guard>
        }
      />
      <Route path="/continue" element={<ContinuePage />} />
      <Route
        path="/dashboard"
        element={
          <Guard>
            <DashboardPage />
          </Guard>
        }
      />
      <Route path="/oauth/consent" element={<ConsentPage />} />
    </Routes>
  );
}
