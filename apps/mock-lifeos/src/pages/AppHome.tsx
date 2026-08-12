import { useNavigate } from "react-router-dom";
import { clearLifeOsSession, getLifeOsProfile } from "../lib/oauth";

function Stars({ stars, maxStars }: { stars: number; maxStars: number }) {
  const filled = Math.max(0, Math.min(maxStars, Math.floor(stars)));
  return (
    <span
      className="lifeos-stars"
      role="img"
      aria-label={`${filled} of ${maxStars} trust stars`}
    >
      {Array.from({ length: maxStars }, (_, i) => (
        <span key={i} className={i < filled ? "filled" : ""} aria-hidden="true">
          ★
        </span>
      ))}
    </span>
  );
}

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
        LifeOS received a zero-knowledge trust claim from TrustID — no email,
        name, or portrait was transferred.
      </p>
      <div className="panel lifeos-identity">
        <div className="lifeos-avatar lifeos-avatar-fallback" aria-hidden="true">
          ZK
        </div>
        <div>
          <div className="label">Trust stage (ZK claim)</div>
          <Stars stars={profile.stars ?? 0} maxStars={profile.maxStars ?? 3} />
          {profile.trustLabel && (
            <div className="mono" style={{ marginTop: "0.35rem" }}>
              {profile.trustLabel}
              {profile.claimSatisfied ? " · claim satisfied" : ""}
            </div>
          )}
        </div>
      </div>
      <div className="panel">
        <div className="label">Nullifier (RP-bound)</div>
        <div className="mono" style={{ wordBreak: "break-all" }}>
          {profile.nullifier}
        </div>
      </div>
      <div className="panel">
        <div className="label">LifeOS session</div>
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
