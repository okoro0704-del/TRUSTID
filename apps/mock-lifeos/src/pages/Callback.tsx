import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  exchangeCode,
  fetchUserInfo,
  upsertLifeOsProfile,
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
        const identity = await fetchUserInfo(tokens.access_token);
        sessionStorage.setItem("lifeos.accessToken", tokens.access_token);
        upsertLifeOsProfile(identity);
        navigate("/app", { replace: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Callback failed");
      }
    })();
  }, [params, navigate]);

  return (
    <div className="wrap">
      <h1>Connecting…</h1>
      {error ? <p className="error">{error}</p> : <p>Exchanging TrustID authorization…</p>}
    </div>
  );
}
