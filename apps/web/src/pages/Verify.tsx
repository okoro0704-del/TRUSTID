import { FormEvent, useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { AuthChrome } from "../components/AuthChrome";

type Onboarding = {
  userId: string;
  trustId: string;
  challengeId: string;
  debugCode?: string;
  contactType: string;
};

export function VerifyPage() {
  const navigate = useNavigate();
  const onboarding = useMemo(() => {
    const raw = sessionStorage.getItem("trustid.onboarding");
    return raw ? (JSON.parse(raw) as Onboarding) : null;
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!onboarding) return <Navigate to="/register" replace />;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    try {
      await api("/auth/verify", {
        method: "POST",
        body: JSON.stringify({
          challengeId: onboarding!.challengeId,
          code: String(fd.get("code") || "").trim(),
        }),
      });
      sessionStorage.setItem(
        "trustid.onboarding",
        JSON.stringify({ ...onboarding, verified: true }),
      );
      navigate("/secure");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthChrome title="Verify" backTo="/register">
      <form className="panel surface-block" onSubmit={onSubmit}>
        <h1>Verify</h1>
        <p className="lead">
          Confirm ownership of your {onboarding.contactType}. This is contact
          verification — not high-assurance identity proofing.
        </p>
        {onboarding.debugCode && (
          <p className="notice">Dev code: {onboarding.debugCode}</p>
        )}
        <div className="field">
          <label htmlFor="code">Verification code</label>
          <input id="code" name="code" inputMode="numeric" required autoComplete="one-time-code" />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary continue-primary" type="submit" disabled={busy}>
          {busy ? "Verifying…" : "Verify"}
        </button>
      </form>
    </AuthChrome>
  );
}
