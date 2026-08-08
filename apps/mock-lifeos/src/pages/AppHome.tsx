import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  clearLifeOsSession,
  fetchVerifiedPortrait,
  getLifeOsProfile,
} from "../lib/oauth";

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
  const [portraitUrl, setPortraitUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!profile?.hasVerifiedPortrait) return;
    const token = sessionStorage.getItem("lifeos.accessToken");
    if (!token) return;
    fetchVerifiedPortrait(token)
      .then((p) => setPortraitUrl(p?.url ?? null))
      .catch(() => setPortraitUrl(null));
  }, [profile?.hasVerifiedPortrait]);

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
      <div className="panel lifeos-identity">
        {portraitUrl ? (
          <img
            className="lifeos-avatar"
            src={portraitUrl}
            alt="Verified identity portrait"
            width={72}
            height={72}
          />
        ) : (
          <div className="lifeos-avatar lifeos-avatar-fallback" aria-hidden="true">
            {(profile.displayName || "?").slice(0, 1).toUpperCase()}
          </div>
        )}
        <div>
          <div className="label">Trust stage (same as TrustID)</div>
          <Stars stars={profile.stars ?? 0} maxStars={profile.maxStars ?? 3} />
          {profile.trustLabel && (
            <div className="mono" style={{ marginTop: "0.35rem" }}>
              {profile.trustLabel}
            </div>
          )}
        </div>
      </div>
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
