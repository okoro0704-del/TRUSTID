import { useNavigate } from "react-router-dom";
import { clearLifeOsSession, getLifeOsProfile } from "../lib/oauth";

export function AppHome() {
  const navigate = useNavigate();
  const profile = getLifeOsProfile();

  if (!profile) {
    navigate("/");
    return null;
  }

  return (
    <div className="wrap">
      <h1>Welcome to LifeOS</h1>
      <p>
        Your LifeOS profile is application-specific and keyed by TrustID — not a
        second login system.
      </p>
      <div className="panel">
        <div className="label">TrustID</div>
        <div className="mono">{profile.trustId}</div>
      </div>
      <div className="panel">
        <div className="label">LifeOS profile</div>
        <div>{profile.displayName}</div>
        {profile.email && <div className="mono">{profile.email}</div>}
        <p style={{ marginBottom: 0 }}>
          Created {new Date(profile.createdAt).toLocaleString()}
          <br />
          Last login {new Date(profile.lastLoginAt).toLocaleString()}
        </p>
      </div>
      <button
        className="btn"
        onClick={() => {
          clearLifeOsSession();
          navigate("/");
        }}
      >
        Leave LifeOS
      </button>
    </div>
  );
}
