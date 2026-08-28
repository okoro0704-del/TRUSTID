import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { WelcomePage } from "./pages/Welcome";
import { RegisterPage } from "./pages/Register";
import { VerifyPage } from "./pages/Verify";
import { SecurePage } from "./pages/Secure";
import { SecuredPage } from "./pages/Secured";
import { ContinuePage } from "./pages/Continue";
import { ConsentPage } from "./pages/Consent";
import { EnrollPage } from "./pages/Enroll";
import { WaitingApprovalPage } from "./pages/WaitingApproval";
import { TrustCenterLayout } from "./components/TrustCenterLayout";
import { OverviewPage } from "./pages/trust/Overview";
import { DevicesPage } from "./pages/trust/Devices";
import { DeviceDetailPage } from "./pages/trust/DeviceDetail";
import { ApprovalsPage } from "./pages/trust/Approvals";
import { TemporaryDevicesPage } from "./pages/trust/TemporaryDevices";
import { NotificationsPage } from "./pages/trust/Notifications";
import { ApplicationsPage } from "./pages/trust/Applications";
import { SessionsPage } from "./pages/trust/Sessions";
import { PasskeysPage } from "./pages/trust/Passkeys";
import { MediaVaultPage } from "./pages/trust/MediaVault";
import { VaultDashboardPage } from "./pages/trust/VaultDashboard";
import { AppLockerPage } from "./pages/trust/AppLocker";
import { DeviceSyncPage } from "./pages/trust/DeviceSync";
import { GuardiansPage } from "./pages/trust/GuardiansPage";
import { AccountPage } from "./pages/trust/Account";
import { IdentityPage } from "./pages/trust/Identity";
import { ControlCenterPage } from "./pages/trust/ControlCenter";

function Guard({ children }: { children: React.ReactNode }) {
  const { loading, identity } = useAuth();
  if (loading)
    return (
      <div className="app-frame">
        <p className="muted" style={{ padding: "2rem" }}>
          Loading…
        </p>
      </div>
    );
  if (!identity) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/vault" element={<Navigate to="/dashboard/vault" replace />} />
      <Route path="/" element={<WelcomePage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/verify" element={<VerifyPage />} />
      <Route path="/secure" element={<SecurePage />} />
      <Route path="/secured" element={<SecuredPage />} />
      <Route path="/continue" element={<ContinuePage />} />
      <Route path="/enroll" element={<EnrollPage />} />
      <Route path="/waiting-approval" element={<WaitingApprovalPage />} />
      <Route path="/oauth/consent" element={<ConsentPage />} />
      <Route
        path="/dashboard"
        element={
          <Guard>
            <TrustCenterLayout />
          </Guard>
        }
      >
        <Route index element={<OverviewPage />} />
        {/* Primary consumer tabs */}
        <Route path="apps" element={<AppLockerPage />} />
        <Route path="media" element={<MediaVaultPage />} />
        <Route path="control" element={<ControlCenterPage />} />
        <Route path="app-locker" element={<Navigate to="/dashboard/apps" replace />} />
        <Route path="media-vault" element={<Navigate to="/dashboard/media" replace />} />
        <Route path="security" element={<Navigate to="/dashboard/control" replace />} />
        {/* Secondary / account tools */}
        <Route path="devices" element={<DevicesPage />} />
        <Route path="devices/:id" element={<DeviceDetailPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="temporary" element={<TemporaryDevicesPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="applications" element={<ApplicationsPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="passkeys" element={<PasskeysPage />} />
        <Route path="vault" element={<VaultDashboardPage />} />
        <Route path="device-sync" element={<DeviceSyncPage />} />
        <Route path="guardians" element={<GuardiansPage />} />
        <Route path="identity" element={<IdentityPage />} />
        <Route path="account" element={<AccountPage />} />
      </Route>
    </Routes>
  );
}
