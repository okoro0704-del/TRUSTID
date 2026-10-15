import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { reauthenticateWithUserVerification } from "../lib/reauth";
import { enrollAndroidMasterDevice, revokeFromThisPhone } from "../lib/masterDeviceNative";

/**
 * Step-up requests from apps (mybrandOS Digi Twin, AI likeness consent, sensitive account changes):
 * each one asks the person to approve ONE operation. Approval is a signature by this phone's
 * Master Device key (Android Keystore, hardware-backed, attested) after a fresh strong biometric.
 * A login session never stands in for it.
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

type DeviceStatus = {
  enrollment_enabled: boolean;
  registered: boolean;
  device: { id: string; enrolled_at: string; last_used_at: string | null; platform: string; security_level: string | null } | null;
  recovery_required: boolean;
  enrollment_available_at: string | null;
};

type Activity = { type: string; at: string; client: string | null; action: string | null; reason: string | null };

const ACTION_LABELS: Record<string, string> = {
  "mybrandos.digitwin.brief": "Show your Digi Twin briefing",
  "mybrandos.digitwin.ask": "Answer a question with your Digi Twin",
  "mybrandos.likeness.approve": "Allow an AI video or photo of you",
};

const ACTIVITY_LABELS: Record<string, string> = {
  "master_device.registered": "Master Device enrolled",
  "step_up.master_device_revoked": "Master Device revoked",
  "step_up.master_device_enrollment_failed": "Enrollment attempt failed",
  "step_up.challenge_created": "Request received",
  "step_up.challenge_approved": "Request approved",
  "step_up.challenge_consumed": "Approval used",
  "step_up.challenge_denied": "Request declined",
  "step_up.challenge_expired": "Request expired",
  "step_up.approval_failed": "Approval attempt failed",
};

const FINGERPRINT_KEY = "trustid.master_device.fingerprint";

/** A stable, random id for this installation (kept in encrypted storage). */
async function deviceFingerprint(): Promise<string> {
  const gate = window.TrustIdBiometricGate;
  const stored = (await gate?.getSecure?.({ key: FINGERPRINT_KEY }).catch(() => null))?.value;
  if (stored) return stored;
  const fresh = `trustid-device-${crypto.randomUUID()}`;
  await gate?.storeSecure?.({ key: FINGERPRINT_KEY, value: fresh });
  return fresh;
}

function describe(err: unknown, fallback: string) {
  if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "cancelled") return "Cancelled.";
  return err instanceof Error ? err.message : fallback;
}

export function StepUpRequests() {
  const { identity } = useAuth();
  const trustId = identity?.trustId ?? "";
  const [requests, setRequests] = useState<StepUpRequest[]>([]);
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [thisPhoneHoldsKey, setThisPhoneHoldsKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const native = typeof window !== "undefined" ? window.TrustIdMasterDevice : undefined;

  const load = useCallback(async () => {
    const [pending, st, act] = await Promise.all([
      api<{ challenges: StepUpRequest[] }>("/v1/step-up/pending"),
      api<DeviceStatus>("/v1/step-up/master-device"),
      api<{ events: Activity[] }>("/v1/step-up/master-device/activity"),
    ]);
    setRequests(pending.challenges);
    setStatus(st);
    setActivity(act.events.slice(0, 10));
    if (native) setThisPhoneHoldsKey(Boolean((await native.getSupport().catch(() => null))?.activeAlias) && st.registered);
  }, [native]);

  useEffect(() => {
    load().catch(() => undefined);
    const t = setInterval(() => load().catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, [load]);

  async function enrollThisPhone() {
    if (!native) return;
    setBusy("enroll");
    setError(null);
    try {
      const done = await enrollAndroidMasterDevice({
        api,
        native,
        passkey: reauthenticateWithUserVerification,
        trustId,
        deviceFingerprint: await deviceFingerprint(),
      });
      setNotice(`This phone is now your Master Device (${done.securityLevel === "strongbox" ? "StrongBox" : "secure hardware"}).`);
      await load();
    } catch (err) {
      setError(describe(err, "This phone could not be enrolled."));
    } finally {
      setBusy(null);
    }
  }

  async function revokeThisPhone() {
    if (!native || !status?.device) return;
    if (!window.confirm("Remove this phone as your Master Device? Apps will not be able to get approvals until you enroll a device again.")) return;
    setBusy("revoke");
    setError(null);
    try {
      await revokeFromThisPhone({ api, native, passkey: reauthenticateWithUserVerification, trustId, masterDeviceId: status.device.id });
      setNotice("This phone is no longer your Master Device.");
      await load();
    } catch (err) {
      setError(describe(err, "Could not remove this phone."));
    } finally {
      setBusy(null);
    }
  }

  async function approve(request: StepUpRequest) {
    if (!native || !request.signing_payload) return;
    setBusy(request.challenge_id);
    setError(null);
    try {
      const label = ACTION_LABELS[request.action] ?? request.action;
      // The biometric prompt names the app and the action; the key signs exactly the server's bytes.
      const { signature } = await native.sign({
        payload: request.signing_payload,
        title: label,
        subtitle: `Requested by ${request.client_name ?? "an app"}`,
      });
      await api(`/v1/step-up/challenges/${encodeURIComponent(request.challenge_id)}/master-device/approve`, {
        method: "POST",
        body: JSON.stringify({ device_fingerprint: await deviceFingerprint(), signature }),
      });
      setNotice(`Approved: ${label}`);
      await load();
    } catch (err) {
      setError(describe(err, "Approval failed."));
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
      setError(describe(err, "Could not decline."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="section" data-step-up-requests="true">
      <h2>Master Device</h2>
      {!status ? null : status.registered && status.device ? (
        <div className="row">
          <div className="row-main">
            <strong>{thisPhoneHoldsKey ? "This phone is your Master Device" : "Your Master Device is another phone"}</strong>
            <span className="muted">
              Enrolled {new Date(status.device.enrolled_at).toLocaleDateString()}
              {status.device.last_used_at ? ` · last used ${new Date(status.device.last_used_at).toLocaleString()}` : ""}
              {status.device.security_level ? ` · ${status.device.security_level === "strongbox" ? "StrongBox" : "secure hardware"}` : ""}
            </span>
          </div>
          {thisPhoneHoldsKey ? (
            <button className="btn" type="button" disabled={busy !== null} onClick={() => void revokeThisPhone()}>
              {busy === "revoke" ? "Removing…" : "Remove"}
            </button>
          ) : null}
        </div>
      ) : status.recovery_required ? (
        <p className="muted">Your previous Master Device was removed without the phone. Adding a new one needs account recovery.</p>
      ) : !status.enrollment_enabled ? (
        <p className="muted">Adding a Master Device is not available yet.</p>
      ) : !native ? (
        <p className="muted">Open the TrustID app on your phone to make it your Master Device.</p>
      ) : (
        <div className="row">
          <div className="row-main">
            <strong>Use this phone to approve requests</strong>
            <span className="muted">Needs your fingerprint or face, then your passkey.</span>
          </div>
          <button className="btn btn-primary" type="button" disabled={busy !== null} onClick={() => void enrollThisPhone()}>
            {busy === "enroll" ? "Setting up…" : "Use this phone"}
          </button>
        </div>
      )}

      <h2>Requests from apps</h2>
      <p className="sub">Each request allows one thing, once. You approve it on your Master Device with your fingerprint or face.</p>
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
                    disabled={!thisPhoneHoldsKey || phoneOnly || seconds === 0 || busy !== null}
                    onClick={() => void approve(request)}
                  >
                    {busy === request.challenge_id ? "Approving…" : "Approve"}
                  </button>
                  <button className="btn" type="button" disabled={busy !== null} onClick={() => void deny(request)}>
                    Decline
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {activity.length ? (
        <>
          <h2>Recent security activity</h2>
          <ul className="list">
            {activity.map((a, i) => (
              <li key={`${a.at}-${i}`} className="row">
                <div className="row-main">
                  <strong>{ACTIVITY_LABELS[a.type] ?? a.type}</strong>
                  <span className="muted">
                    {new Date(a.at).toLocaleString()}
                    {a.action ? ` · ${ACTION_LABELS[a.action] ?? a.action}` : ""}
                    {a.client ? ` · ${a.client}` : ""}
                    {a.reason ? ` · ${a.reason}` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {notice ? <p className="muted">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
