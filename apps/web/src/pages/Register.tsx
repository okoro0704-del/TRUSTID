import { FormEvent, useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { AuthChrome } from "../components/AuthChrome";
import { gateCreateTrustId } from "../lib/deviceGate";
import { getOrCreateInstallId } from "../lib/deviceInstall";

export function RegisterPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<"checking" | "allow" | "blocked">("checking");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await gateCreateTrustId();
      if (cancelled) return;
      if (result.action === "continue") {
        setGate("blocked");
        navigate("/continue", { replace: true });
        return;
      }
      setGate("allow");
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email") || "").trim();
    const phone = String(fd.get("phone") || "").trim();
    if (!email && !phone) {
      setError("Enter an email or phone number to continue.");
      setBusy(false);
      return;
    }
    try {
      const installId = await getOrCreateInstallId();
      const result = await api<{
        userId: string;
        trustId: string;
        challengeId: string;
        debugCode?: string;
        contactType: string;
      }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({
          firstName: String(fd.get("firstName") || "").trim(),
          lastName: String(fd.get("lastName") || "").trim(),
          email: email || undefined,
          phone: phone || undefined,
          installId,
        }),
      });
      sessionStorage.setItem(
        "trustid.onboarding",
        JSON.stringify({
          userId: result.userId,
          trustId: result.trustId,
          challengeId: result.challengeId,
          debugCode: result.debugCode,
          contactType: result.contactType,
          firstName: String(fd.get("firstName") || "").trim(),
          lastName: String(fd.get("lastName") || "").trim(),
          email: email || undefined,
          phone: phone || undefined,
          installId,
        }),
      );
      navigate("/verify");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Registration failed";
      if (/already has a TrustID/i.test(message)) {
        navigate("/continue", { replace: true });
        return;
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  if (gate === "checking") {
    return (
      <AuthChrome title="Create">
        <p className="muted">Checking this device…</p>
      </AuthChrome>
    );
  }

  if (gate === "blocked") {
    return <Navigate to="/continue" replace />;
  }

  return (
    <AuthChrome title="Create" backTo="/">
      <form className="panel surface-block" onSubmit={onSubmit}>
        <h1>Create TrustID</h1>
        <p className="lead">Minimum details. One identity for this phone.</p>
        <div className="field">
          <label htmlFor="firstName">First name</label>
          <input id="firstName" name="firstName" required autoComplete="given-name" />
        </div>
        <div className="field">
          <label htmlFor="lastName">Last name</label>
          <input id="lastName" name="lastName" required autoComplete="family-name" />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="phone">Phone</label>
          <input id="phone" name="phone" type="tel" autoComplete="tel" placeholder="+15551234567" />
        </div>
        <p className="muted">Provide at least one contact method to verify.</p>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary continue-primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Continue"}
        </button>
        <p className="muted">
          Already have one? <Link to="/continue">Use passkey</Link>
        </p>
      </form>
    </AuthChrome>
  );
}
