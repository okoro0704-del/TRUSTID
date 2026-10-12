import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { prefetchReauth, reauthenticate } from "../../lib/reauth";
import {
  assertEnrollmentPayloadMatches,
  assertStepUpPayloadMatches,
  generateDeviceKey,
  keyThumbprint,
  newDeviceFingerprint,
  revokePayload,
  signPayload,
} from "../../lib/masterDeviceCrypto";
import { forgetDevice, loadDevice, saveDevice, type StoredDevice } from "../../lib/masterDeviceStore";

type DeviceStatus = {
  registered: boolean;
  device: { id: string; enrolled_at: string; last_used_at: string | null; key_thumbprint: string } | null;
  enrollment_available_at: string | null;
};

type PendingRequest = {
  challenge_id: string;
  status: string;
  method: string;
  action: string;
  operation_digest: string;
  expires_at: string;
  client_name?: string;
  signing_payload?: string;
};

type Outcome = { id: string; action: string; client: string; result: string; ok: boolean; at: number };

const POLL_MS = 3000;

/** Inside a frame another site could overlay the Approve button (clickjacking): refuse to act. */
function isFramed() {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function secondsLeft(iso: string, now: number) {
  return Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
}

/** Plain-language result of an approve/deny call; never treats a failure as success. */
function describeFailure(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 410) return "Expired before it was approved.";
    if (err.status === 409) return "No longer pending (cancelled, already decided, or used).";
    if (err.status === 404) return "Not found for this TrustID.";
    if (err.status === 403) return "This device is not the Master Device for the request.";
    if (err.status === 401) return "The device signature was rejected.";
    if (err.status === 0) return err.message;
    return err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * Trust Center: Master Device for step-up approvals (LifeOS Portal and other TrustID apps).
 * Approval is a signature by this device's non-extractable key over the exact request shown,
 * never a click alone; the API verifies it against the enrolled public key.
 */
export function MasterDevicePage() {
  const { identity } = useAuth();
  const trustId = identity?.trustId ?? "";
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [local, setLocal] = useState<StoredDevice | null>(null);
  const [localMatches, setLocalMatches] = useState(false);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const handled = useRef(new Set<string>());
  const framed = isFramed();

  const refresh = useCallback(async () => {
    const [s, p, stored] = await Promise.all([
      api<DeviceStatus>("/v1/step-up/master-device"),
      api<{ challenges: PendingRequest[] }>("/v1/step-up/pending"),
      loadDevice(),
    ]);
    setStatus(s);
    setPending(p.challenges.filter((c) => !handled.current.has(c.challenge_id)));
    const usable = stored && stored.trustId === trustId ? stored : null;
    setLocal(usable);
    setLocalMatches(Boolean(usable && s.device && (await keyThumbprint(usable.publicKeySpki)) === s.device.key_thumbprint));
  }, [trustId]);

  useEffect(() => {
    if (!trustId) return;
    refresh().catch((err) => setError(describeFailure(err)));
    prefetchReauth();
    const poll = setInterval(() => refresh().catch(() => undefined), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [trustId, refresh]);

  function record(req: PendingRequest, result: string, ok: boolean) {
    handled.current.add(req.challenge_id);
    setPending((list) => list.filter((c) => c.challenge_id !== req.challenge_id));
    setOutcomes((list) =>
      [{ id: req.challenge_id, action: req.action, client: req.client_name ?? "Unknown app", result, ok, at: Date.now() }, ...list].slice(0, 10),
    );
  }

  async function enroll() {
    setBusy("enroll");
    setError(null);
    setNotice(null);
    try {
      const key = await generateDeviceKey();
      const begun = await api<{ enrollment: string; signing_payload: string; expires_at: string }>(
        "/v1/step-up/master-device/enrollment",
        { method: "POST", body: JSON.stringify({ public_key: key.publicKeySpki }) },
      );
      await assertEnrollmentPayloadMatches(begun.signing_payload, { trustId, publicKeySpki: key.publicKeySpki });
      const signature = await signPayload(key.privateKey, begun.signing_payload);
      const reauth = await reauthenticate();
      const deviceFingerprint = newDeviceFingerprint();
      await api("/v1/step-up/master-device/enrollment/complete", {
        method: "POST",
        body: JSON.stringify({
          enrollment: begun.enrollment,
          public_key: key.publicKeySpki,
          device_fingerprint: deviceFingerprint,
          signature,
          reauth,
        }),
      });
      await saveDevice({
        privateKey: key.privateKey,
        publicKeySpki: key.publicKeySpki,
        deviceFingerprint,
        trustId,
        enrolledAt: new Date().toISOString(),
      });
      setNotice("This device is now your Master Device.");
      await refresh();
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (!status?.device) return;
    const withDevice = localMatches && local;
    const confirmed = window.confirm(
      withDevice
        ? "Revoke this Master Device? You can enroll a new one right away."
        : "Revoke your Master Device without it? For your safety, a new Master Device can only be enrolled after 24 hours.",
    );
    if (!confirmed) return;
    setBusy("revoke");
    setError(null);
    setNotice(null);
    try {
      const deviceSignature = withDevice ? await signPayload(local.privateKey, revokePayload(trustId, status.device.id)) : undefined;
      const reauth = await reauthenticate();
      const result = await api<{ enrollment_available_at: string | null }>("/v1/step-up/master-device/revoke", {
        method: "POST",
        body: JSON.stringify({ reauth, ...(deviceSignature ? { device_signature: deviceSignature } : {}) }),
      });
      if (withDevice) await forgetDevice();
      setNotice(
        result.enrollment_available_at
          ? `Master Device revoked. A new one can be enrolled after ${new Date(result.enrollment_available_at).toLocaleString()}.`
          : "Master Device revoked.",
      );
      await refresh();
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setBusy(null);
    }
  }

  async function approve(req: PendingRequest) {
    if (!local || !localMatches || !status?.device || !req.signing_payload) return;
    setBusy(req.challenge_id);
    setError(null);
    try {
      // Refuses to sign anything other than exactly what is displayed for this request.
      assertStepUpPayloadMatches(req.signing_payload, req, { trustId, masterDeviceId: status.device.id });
      const signature = await signPayload(local.privateKey, req.signing_payload);
      await api(`/v1/step-up/challenges/${req.challenge_id}/master-device/approve`, {
        method: "POST",
        body: JSON.stringify({ device_fingerprint: local.deviceFingerprint, signature }),
      });
      record(req, "Approved with this Master Device.", true);
    } catch (err) {
      record(req, describeFailure(err), false);
    } finally {
      setBusy(null);
    }
  }

  async function deny(req: PendingRequest) {
    setBusy(req.challenge_id);
    setError(null);
    try {
      await api(`/v1/step-up/challenges/${req.challenge_id}/deny`, { method: "POST" });
      record(req, "Denied.", true);
    } catch (err) {
      record(req, describeFailure(err), false);
    } finally {
      setBusy(null);
    }
  }

  if (framed) {
    return (
      <div className="dashboard">
        <section className="section">
          <h2>Master Device</h2>
          <p className="error" role="alert">
            For your safety, Master Device approvals only work when TrustID is open directly, not inside another site.
          </p>
        </section>
      </div>
    );
  }

  const cooldown = status?.enrollment_available_at && Date.parse(status.enrollment_available_at) > now ? status.enrollment_available_at : null;

  return (
    <div className="dashboard">
      <section className="section">
        <h2>Master Device</h2>
        <p className="sub">
          Your Master Device approves sensitive actions requested by apps that use TrustID, such as LifeOS Portal admin
          changes. Approving signs the exact request with a key that never leaves this device.
        </p>
        {error ? <p className="error" role="alert">{error}</p> : null}
        {notice ? <p className="muted" role="status">{notice}</p> : null}
        {!status ? (
          <p className="muted">Loading…</p>
        ) : !status.registered ? (
          <>
            <p className="muted">No Master Device is enrolled.</p>
            {cooldown ? (
              <p className="muted">A new Master Device can be enrolled after {new Date(cooldown).toLocaleString()}.</p>
            ) : (
              <button className="btn btn-primary" type="button" disabled={busy !== null || !trustId} onPointerDown={() => prefetchReauth()} onClick={() => void enroll()}>
                {busy === "enroll" ? "Enrolling…" : "Make this device my Master Device"}
              </button>
            )}
            <p className="muted small">You will confirm with this device's passkey.</p>
          </>
        ) : (
          <>
            <p>
              <strong>{localMatches ? "This device is your Master Device." : "Your Master Device is another device."}</strong>
            </p>
            <p className="muted">
              Enrolled {new Date(status.device!.enrolled_at).toLocaleString()}
              {status.device!.last_used_at ? ` · last used ${new Date(status.device!.last_used_at).toLocaleString()}` : ""}
            </p>
            {!localMatches ? <p className="muted">Approve requests on that device. If it is lost, revoke it here.</p> : null}
            <button className="btn btn-ghost" type="button" disabled={busy !== null} onPointerDown={() => prefetchReauth()} onClick={() => void revoke()}>
              {busy === "revoke" ? "Revoking…" : localMatches ? "Revoke this device" : "Revoke lost Master Device"}
            </button>
          </>
        )}
      </section>

      <section className="section">
        <h2>Requests waiting for approval</h2>
        {pending.length === 0 ? (
          <p className="muted">No pending requests.</p>
        ) : (
          <ul className="list">
            {pending.map((req) => {
              const left = secondsLeft(req.expires_at, now);
              const canSign = req.method === "master_device" && localMatches && Boolean(req.signing_payload);
              return (
                <li key={req.challenge_id} className="row">
                  <div className="row-main">
                    <strong>{req.client_name ?? "Unknown app"}</strong>
                    <span>
                      wants to: <code>{req.action}</code>
                    </span>
                    <span className="muted small">
                      Request fingerprint <code>{req.operation_digest.slice(0, 12)}</code> ·{" "}
                      {left > 0 ? `expires in ${left}s` : "expired"}
                    </span>
                    {req.method !== "master_device" ? (
                      <span className="muted small">Biometric approval is not available yet. Deny it, or ask the app to use your Master Device.</span>
                    ) : !localMatches ? (
                      <span className="muted small">Open TrustID on your Master Device to approve.</span>
                    ) : null}
                  </div>
                  <div className="actions">
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={!canSign || left === 0 || busy !== null}
                      onClick={() => void approve(req)}
                    >
                      {busy === req.challenge_id ? "Signing…" : "Approve"}
                    </button>
                    <button className="btn btn-ghost" type="button" disabled={busy !== null} onClick={() => void deny(req)}>
                      Deny
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {outcomes.length > 0 ? (
        <section className="section">
          <h2>Just now</h2>
          <ul className="list">
            {outcomes.map((o) => (
              <li key={`${o.id}-${o.at}`} className="row">
                <div className="row-main">
                  <strong>{o.client}</strong>
                  <span className="muted">
                    <code>{o.action}</code> · {o.result}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
