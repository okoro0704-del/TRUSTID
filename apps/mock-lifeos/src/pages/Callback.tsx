import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  exchangeCode,
  fetchUserInfo,
  proveTrustTier,
  upsertLifeOsProfile,
  verifyZkProof,
} from "../lib/oauth";

export function Callback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const err = params.get("error");
    if (err) {
      setError(err);
      return;
    }
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setError("Missing authorization code");
      return;
    }

    (async () => {
      try {
        const tokens = await exchangeCode(code, state);
        sessionStorage.setItem("lifeos.accessToken", tokens.access_token);
        const identity = await fetchUserInfo(tokens.access_token);
        const proof = await proveTrustTier(tokens.access_token, 1);
        const valid = await verifyZkProof(proof);
        if (!valid) throw new Error("ZK proof verification failed");
        upsertLifeOsProfile({
          nullifier: proof.trustIdNullifier,
          trustIdHint: identity.trustId ?? identity.sub,
          stars: proof.stars,
          maxStars: proof.maxStars,
          trustLabel: proof.label,
          claimSatisfied: proof.claim.satisfied,
        });
        navigate("/app", { replace: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Callback failed");
      }
    })();
  }, [params, navigate]);

  return (
    <div className="wrap">
      <h1>Connecting…</h1>
      {error ? (
        <p className="error">{error}</p>
      ) : (
        <p>Exchanging authorization and verifying ZK trust claim…</p>
      )}
    </div>
  );
}
