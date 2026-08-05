import { useMemo, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

export function ConsentPage() {
  const { loading, identity } = useAuth();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const consent = useMemo(
    () => ({
      client_id: params.get("client_id") ?? "",
      redirect_uri: params.get("redirect_uri") ?? "",
      scope: params.get("scope") ?? "",
      state: params.get("state") ?? "",
      code_challenge: params.get("code_challenge") ?? "",
      code_challenge_method: "S256" as const,
      app_name: params.get("app_name") ?? "Application",
    }),
    [params],
  );

  if (loading) return <div className="shell muted">Loading…</div>;
  if (!identity) {
    const next = `/oauth/consent?${params.toString()}`;
    sessionStorage.setItem("trustid.returnTo", next);
    // Prefer continue (existing users); register also honors returnTo after secure
    return <Navigate to="/continue" replace />;
  }

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ redirectTo: string }>("/oauth/consent", {
        method: "POST",
        body: JSON.stringify({ ...consent, approve }),
      });
      window.location.href = result.redirectTo;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Consent failed");
      setBusy(false);
    }
  }

  const scopes = consent.scope.split(/[\s+]+/).filter(Boolean);

  return (
    <div className="shell">
      <div className="topbar">
        <Link to="/dashboard" className="brand">
          TrustID
        </Link>
      </div>
      <div className="panel">
        <h1>Authorize {consent.app_name}</h1>
        <p className="lead">
          {consent.app_name} wants scoped access to your TrustID. It will not
          receive your passkeys or recovery secrets.
        </p>
        <p className="muted">Signed in as {identity.trustId}</p>
        <ul className="list">
          {scopes.map((s) => (
            <li key={s} className="row">
              <span className="event-type">{s}</span>
            </li>
          ))}
        </ul>
        {error && <p className="error">{error}</p>}
        <div className="inline-actions">
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => decide(true)}
          >
            Allow
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => decide(false)}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
