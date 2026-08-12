import { useEffect, useState, type FormEvent } from "react";
import {
  fetchGuardianStatus,
  setupGuardianCircle,
} from "../../lib/security/sovereign";
import { api } from "../../lib/api";

export function GuardiansPage() {
  const [status, setStatus] = useState<Awaited<
    ReturnType<typeof fetchGuardianStatus>
  > | null>(null);
  const [threshold, setThreshold] = useState(3);
  const [labels, setLabels] = useState("Hardware token A, Trusted contact B, Trusted contact C");
  const [inviteCodes, setInviteCodes] = useState<
    Array<{ shareIndex: number; inviteCode: string }> | null
  >(null);
  const [claimCode, setClaimCode] = useState("");
  const [claimResult, setClaimResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setStatus(await fetchGuardianStatus());
  }

  useEffect(() => {
    reload().catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load"),
    );
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInviteCodes(null);
    try {
      const guardians = labels
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((label) => ({ label }));
      const res = await setupGuardianCircle({ threshold, guardians });
      setInviteCodes(res.inviteCodes);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke() {
    setBusy(true);
    setError(null);
    try {
      await api("/recovery/guardians/circle", { method: "DELETE", body: "{}" });
      setInviteCodes(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revoke failed");
    } finally {
      setBusy(false);
    }
  }

  async function onClaim(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setClaimResult(null);
    try {
      const res = await api<{
        shareIndex: number;
        guardianLabel: string;
        threshold: number;
      }>("/recovery/guardians/claim", {
        method: "POST",
        body: JSON.stringify({ inviteCode: claimCode }),
      });
      setClaimResult(
        `Claimed share #${res.shareIndex} (${res.guardianLabel}). Threshold ${res.threshold}. Store this share offline.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dashboard">
      <section className="section surface-block">
        <h2>Recovery guardians</h2>
        <p className="sub">
          Shamir&apos;s Secret Sharing (GF(256)) splits your recovery master secret
          across trusted contacts or hardware tokens. TrustID stores only sealed
          shares and a commitment ù never the secret or PII.
        </p>
        {status && (
          <ul className="list compact-list">
            <li className="row">
              <span className="muted">Circle status</span>
              <span>{status.status}</span>
            </li>
            {status.threshold != null && (
              <li className="row">
                <span className="muted">Threshold</span>
                <span>
                  {status.threshold} of {status.shareCount}
                </span>
              </li>
            )}
          </ul>
        )}
        {status?.shares && status.shares.length > 0 && (
          <ul className="list compact-list">
            {status.shares.map((s) => (
              <li key={s.shareIndex} className="row">
                <div className="row-main">
                  <strong>{s.guardianLabel}</strong>
                  <span className="muted">
                    Share #{s.shareIndex} ù {s.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {status?.status === "active" || status?.status === "recovering" ? (
          <button type="button" className="btn btn-danger" disabled={busy} onClick={onRevoke}>
            Revoke circle
          </button>
        ) : (
          <form className="stack-form" onSubmit={onCreate}>
            <div className="field">
              <label htmlFor="threshold">Threshold (t)</label>
              <input
                id="threshold"
                type="number"
                min={2}
                max={8}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="labels">Guardian labels (comma-separated)</label>
              <input
                id="labels"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              Create guardian circle
            </button>
          </form>
        )}
        {inviteCodes && (
          <div className="surface-block" style={{ marginTop: "1rem" }}>
            <h3>One-time invite codes</h3>
            <p className="muted">Show each code once to the matching guardian. Not stored again.</p>
            <ul className="list compact-list">
              {inviteCodes.map((c) => (
                <li key={c.shareIndex} className="row">
                  <span>Share #{c.shareIndex}</span>
                  <code className="tid">{c.inviteCode}</code>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="section surface-block">
        <h2>Claim a guardian share</h2>
        <p className="sub">Guardians paste their invite code ù no TrustID account PII required.</p>
        <form className="stack-form" onSubmit={onClaim}>
          <div className="field">
            <label htmlFor="claim">Invite code</label>
            <input
              id="claim"
              value={claimCode}
              onChange={(e) => setClaimCode(e.target.value)}
              autoComplete="off"
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || !claimCode.trim()}>
            Claim share
          </button>
        </form>
        {claimResult && <p className="status-ok">{claimResult}</p>}
      </section>
    </div>
  );
}
