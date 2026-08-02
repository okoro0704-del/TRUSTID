import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";

export function RegisterPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email") || "").trim();
    const phone = String(fd.get("phone") || "").trim();
    try {
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
        }),
      );
      navigate("/verify");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <div className="topbar">
        <Link to="/" className="brand">
          TrustID
        </Link>
      </div>
      <form className="panel" onSubmit={onSubmit}>
        <h1>Create TrustID</h1>
        <p className="lead">Minimum details. One identity for the ecosystem.</p>
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
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
