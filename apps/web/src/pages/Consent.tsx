import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { setReturnTo } from "../lib/returnTo";
import { AuthChrome } from "../components/AuthChrome";

function forceConsentUi(prompt?: string | null): boolean {
  if (!prompt) return false;
  return prompt
    .split(/[\s+]+/)
    .map((p) => p.trim().toLowerCase())
    .includes("consent");
}

function SilentShell({ children }: { children?: ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "#0b1210",
        margin: 0,
        display: children ? "grid" : undefined,
        placeItems: children ? "center" : undefined,
        padding: children ? "1.5rem" : undefined,
        color: "#f4f7f6",
      }}
      aria-busy={!children}
    >
      {children ?? (
        <span className="sr-only" aria-live="polite">
          Returning to LifeOS Business
        </span>
      )}
    </div>
  );
}

/**
 * OAuth finish page. After TrustID login we auto-approve and return to the app.
 * The Allow / Deny screen only appears when prompt=consent is requested.
 */
export function ConsentPage() {
  const { loading, identity } = useAuth();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** null = connecting; true = show Allow UI; false = redirecting */
  const [needsConsent, setNeedsConsent] = useState<boolean | null>(null);
  const finishStarted = useRef(false);

  const consent = useMemo(
    () => ({
      client_id: params.get("client_id") ?? "",
      redirect_uri: params.get("redirect_uri") ?? "",
      scope: params.get("scope") ?? "",
      state: params.get("state") ?? "",
      code_challenge: params.get("code_challenge") ?? "",
      code_challenge_method: "S256" as const,
      app_name: params.get("app_name") ?? "Application",
      prompt: params.get("prompt") ?? "",
      ui_mode: params.get("ui_mode") ?? "",
    }),
    [params],
  );
  const silent = consent.ui_mode === "silent";

  useEffect(() => {
    if (loading || !identity) return;
    if (finishStarted.current) return;
    finishStarted.current = true;

    if (forceConsentUi(consent.prompt)) {
      setNeedsConsent(true);
      return;
    }

    void (async () => {
      try {
        const result = await api<{ redirectTo?: string; needsConsent: boolean }>(
          "/oauth/consent/resume",
          {
            method: "POST",
            body: JSON.stringify({
              client_id: consent.client_id,
              redirect_uri: consent.redirect_uri,
              scope: consent.scope,
              state: consent.state,
              code_challenge: consent.code_challenge,
              code_challenge_method: consent.code_challenge_method,
              prompt: consent.prompt || undefined,
            }),
          },
        );
        if (result.redirectTo) {
          setNeedsConsent(false);
          window.location.assign(result.redirectTo);
          return;
        }
        // Fallback: explicit approve (should be rare)
        const approved = await api<{ redirectTo: string }>("/oauth/consent", {
          method: "POST",
          body: JSON.stringify({
            client_id: consent.client_id,
            redirect_uri: consent.redirect_uri,
            scope: consent.scope,
            state: consent.state,
            code_challenge: consent.code_challenge,
            code_challenge_method: consent.code_challenge_method,
            approve: true,
          }),
        });
        setNeedsConsent(false);
        window.location.assign(approved.redirectTo);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not finish sign-in");
        setNeedsConsent(true);
      }
    })();
  }, [loading, identity, consent]);

  if (loading || (identity && needsConsent === null && !error)) {
    if (silent) return <SilentShell />;
    return (
      <AuthChrome title="Connecting">
        <p className="muted">Returning to {consent.app_name}…</p>
      </AuthChrome>
    );
  }
  if (!identity) {
    const next = `/oauth/consent?${params.toString()}`;
    setReturnTo(next);
    return <Navigate to="/continue" replace />;
  }
  if (needsConsent === false) {
    if (silent) return <SilentShell />;
    return (
      <AuthChrome title="Connecting">
        <p className="muted">Returning to {consent.app_name}…</p>
      </AuthChrome>
    );
  }

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ redirectTo: string }>("/oauth/consent", {
        method: "POST",
        body: JSON.stringify({
          client_id: consent.client_id,
          redirect_uri: consent.redirect_uri,
          scope: consent.scope,
          state: consent.state,
          code_challenge: consent.code_challenge,
          code_challenge_method: consent.code_challenge_method,
          approve,
        }),
      });
      window.location.assign(result.redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Consent failed");
      setBusy(false);
    }
  }

  // Only shown for prompt=consent or if auto-finish failed.
  const scopes = consent.scope.split(/[\s+]+/).filter(Boolean);

  return (
    <AuthChrome title="Authorize">
      <div className="panel surface-block">
        <h1>Authorize {consent.app_name}</h1>
        <p className="lead">
          {consent.app_name} wants scoped access to your TrustID. It will not
          receive your passkeys or recovery secrets.
        </p>
        <p className="muted">Signed in as {identity.trustId}</p>
        <ul className="list compact-list">
          {scopes.map((s) => (
            <li key={s} className="row">
              <span className="event-type">{s}</span>
            </li>
          ))}
        </ul>
        {error && <p className="error">{error}</p>}
        <div className="inline-actions stacked-actions">
          <button
            className="btn btn-primary continue-primary"
            disabled={busy}
            onClick={() => decide(true)}
          >
            Allow
          </button>
          <button
            className="btn btn-ghost continue-primary"
            disabled={busy}
            onClick={() => decide(false)}
          >
            Deny
          </button>
        </div>
      </div>
    </AuthChrome>
  );
}
