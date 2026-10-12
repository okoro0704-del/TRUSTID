import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

/**
 * Step-up requests from apps (e.g. mybrandOS Digi Twin, AI likeness consent): each one asks the
 * person to approve ONE operation. Approval is signed on this phone — the Master Device — with a
 * hardware key that only works right after a strong biometric (fingerprint / Class 3 face).
 */
type StepUpRequest = {
  challenge_id: string;
  status: string;
  method: "master_device" | "biometric";
  action: string;
  operation_digest: string;
  expires_at: string;
  client_name?: string;
  signing_payload?: string;
};

const ACTION_LABELS: Record<string, string> = {
  "mybrandos.digitwin.brief": "Show your Digi Twin briefing",
  "mybrandos.digitwin.ask": "Answer a question with your Digi Twin",
  "mybrandos.likeness.approve": "Allow an AI video or photo of you",
};

const FINGERPRINT_KEY = "trustid.master_device.fingerprint";
const REGISTERED_KEY = "trustid.master_device.registered";

function signer() {
  return typeof window !== "undefined" ? window.TrustIdBiometricGate?.signPayload : undefined;
}

const toBase64Url = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A stable, random id for this installation (kept in encrypted storage). */
async function deviceFingerprint(): Promise<string> {
  const gate = window.TrustIdBiometricGate;
  const stored = (await gate?.getSecure?.({ key: FINGERPRINT_KEY }).catch(() => null))?.value;
  if (stored) return stored;
  const fresh = `trustid-device-${crypto.randomUUID()}`;
  await gate?.storeSecure?.({ key: FINGERPRINT_KEY, value: fresh });
  return fresh;
}

export function StepUpRequests() {
  const [requests, setRequests] = useState<StepUpRequest[]>([]);
  const [registered, setRegistered] = useState(() => localStorage.getItem(REGISTERED_KEY) === "true");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canSign = Boolean(signer());

  const load = useCallback(async () => {
    const res = await api<{ challenges: StepUpRequest[] }>("/v1/step-up/pending");
    setRequests(res.challenges);
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
    const t = setInterval(() => load().catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, [load]);

  async function registerThisPhone() {
    const sign = signer();
    if (!sign) return;
    setBusy("register");
    setError(null);
    try {
      const fingerprint = await deviceFingerprint();
      const proof = await sign({
        payload: `trustid-master-device-registration:${fingerprint}`,
        reason: "Use this phone to approve Trust ID requests",
      });
      await api("/v1/trust-id/master-device/register", {
        method: "POST",
        body: JSON.stringify({ deviceFingerprint: fingerprint, publicKey: toBase64Url(proof.publicKeyBase64) }),
      });
      localStorage.setItem(REGISTERED_KEY, "true");
      setRegistered(true);
      setNotice("This phone now approves your Trust ID requests.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "This phone could not be registered.");
    } finally {
      setBusy(null);
    }
  }

  async function approve(request: StepUpRequest) {
    const sign = signer();
    if (!sign || !request.signing_payload) return;
    setBusy(request.challenge_id);
    setError(null);
    try {
      const fingerprint = await deviceFingerprint();
      const label = ACTION_LABELS[request.action] ?? request.action;
      const signed = await sign({
        payload: request.signing_payload,
        reason: `${request.client_name ?? "An app"}: ${label}`,
      });
      await api(`/v1/step-up/challenges/${encodeURIComponent(request.challenge_id)}/master-device/approve`, {
        method: "POST",
        body: JSON.stringify({ device_fingerprint: fingerprint, signature: signed.signatureBase64 }),
      });
      setNotice(`Approved: ${label}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval failed.");
    } finally {
      setBusy(null);
    }
  }

  async function deny(request: StepUpRequest) {
    setBusy(request.challenge_id);
    setError(null);
    try {
      await api(`/v1/step-up/challenges/${encodeURIComponent(request.challenge_id)}/deny`, { method: "POST", body: "{}" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not decline.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="section" data-step-up-requests="true">
      <h2>Requests from apps</h2>
      <p className="sub">
        Each request allows one thing, once. You approve it on this phone with your fingerprint or face.
      </p>

      {!canSign ? (
        <p className="muted">Open the Trust ID app on your phone to approve these requests.</p>
      ) : !registered ? (
        <div className="row">
          <div className="row-main">
            <strong>Use this phone to approve requests</strong>
            <span className="muted">Registers this phone as your Master Device. Needs your fingerprint or face.</span>
          </div>
          <button className="btn btn-primary" type="button" disabled={busy === "register"} onClick={() => void registerThisPhone()}>
            {busy === "register" ? "Registering…" : "Use this phone"}
          </button>
        </div>
      ) : null}

      {requests.length === 0 ? (
        <p className="muted">No requests waiting.</p>
      ) : (
        <ul className="list">
          {requests.map((request) => {
            const label = ACTION_LABELS[request.action] ?? request.action;
            const seconds = Math.max(0, Math.round((new Date(request.expires_at).getTime() - Date.now()) / 1000));
            const phoneOnly = request.method !== "master_device";
            return (
              <li key={request.challenge_id} className="row" data-step-up-id={request.challenge_id}>
                <div className="row-main">
                  <strong>{label}</strong>
                  <span className="muted">
                    {request.client_name ?? "An app"} · expires in {seconds}s
                  </span>
                  {phoneOnly ? <span className="muted">Face-scan approval is not available yet.</span> : null}
                </div>
                <div className="actions">
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={!canSign || !registered || phoneOnly || busy === request.challenge_id}
                    onClick={() => void approve(request)}
                  >
                    {busy === request.challenge_id ? "Approving…" : "Approve"}
                  </button>
                  <button className="btn" type="button" disabled={busy === request.challenge_id} onClick={() => void deny(request)}>
                    Decline
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {notice ? <p className="muted">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
