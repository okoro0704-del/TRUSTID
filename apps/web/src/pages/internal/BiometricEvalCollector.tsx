/**
 * INTERNAL BIOMETRIC EVALUATION collector UI.
 * NOT FOR PRODUCTION ENROLLMENT.
 * Gate: EVAL_BIOMETRIC_SECRET stored only in sessionStorage for this page.
 */
import { useEffect, useRef, useState } from "react";
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_ERROR_CODES,
} from "@trustid/shared";
import {
  extractFaceEmbeddingFromImageData,
  MediaPipeBlinkPadDetector,
} from "@trustid/sdk";
import { ApiError } from "../../lib/api";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";
const SECRET_KEY = "trustid_eval_biometric_secret";

type SessionKey =
  | "enrollment_neutral"
  | "lighting_and_expression"
  | "pose_and_distance";

async function evalApi<T>(
  path: string,
  secret: string,
  init: RequestInit = {},
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const hasBody = init.body != null && init.body !== "";
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    method,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "x-eval-biometric-secret": secret,
      ...(init.headers ?? {}),
    },
    body:
      hasBody
        ? init.body
        : ["POST", "PUT", "PATCH"].includes(method)
          ? "{}"
          : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: string }).error)
        : res.statusText;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

function grabFrame(video: HTMLVideoElement): ImageData | null {
  if (!video.videoWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return data;
}

function frameToJpegBase64(video: HTMLVideoElement): string | null {
  if (!video.videoWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function BiometricEvalCollectorPage() {
  const [secret, setSecret] = useState(() =>
    typeof sessionStorage !== "undefined"
      ? sessionStorage.getItem(SECRET_KEY) ?? ""
      : "",
  );
  const [secretInput, setSecretInput] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState<SessionKey>("enrollment_neutral");
  const [guidance, setGuidance] = useState("");
  const [accepted, setAccepted] = useState(0);
  const [rejected, setRejected] = useState<Array<{ id: number; reason: string }>>(
    [],
  );
  const rejectSeq = useRef(0);
  const [status, setStatus] = useState("");
  const [admin, setAdmin] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const padRef = useRef(new MediaPipeBlinkPadDetector());

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function unlock() {
    try {
      await evalApi("/internal/biometric-eval/status", secretInput);
      sessionStorage.setItem(SECRET_KEY, secretInput);
      setSecret(secretInput);
      setUnlocked(true);
      setStatus("Unlocked (internal evaluation only).");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Unauthorized");
    }
  }

  async function startParticipant() {
    if (!consentChecked) {
      setStatus("Consent required before capture.");
      return;
    }
    setBusy(true);
    try {
      const res = await evalApi<{
        participant: { subject_id: string };
      }>("/internal/biometric-eval/participants", secret, {
        method: "POST",
        body: JSON.stringify({
          consent_given: true,
          consent_timestamp: new Date().toISOString(),
          dataset_version: "1.0.0",
        }),
      });
      setSubjectId(res.participant.subject_id);
      setStatus(`Participant ${res.participant.subject_id} created.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function beginSession(key: SessionKey) {
    if (!subjectId) return;
    setBusy(true);
    try {
      const res = await evalApi<{
        session: { sessionId: string; guidance: string; sessionKey: SessionKey };
      }>("/internal/biometric-eval/sessions", secret, {
        method: "POST",
        body: JSON.stringify({ subject_id: subjectId, sessionKey: key }),
      });
      setSessionKey(res.session.sessionKey);
      setSessionId(res.session.sessionId);
      setGuidance(res.session.guidance);
      setAccepted(0);
      setRejected([]);
      setStatus(`Session started: ${res.session.sessionKey}`);

      // End prior camera stream so sessions are not one continuous capture
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function captureOnce() {
    if (!subjectId || !sessionId || !videoRef.current) return;
    setBusy(true);
    try {
      const frame = grabFrame(videoRef.current);
      if (!frame) {
        rejectSeq.current += 1;
        setRejected((r) => [
          ...r,
          { id: rejectSeq.current, reason: "FRAME_REJECTED reason=NO_FRAME" },
        ]);
        return;
      }
      const extracted = await extractFaceEmbeddingFromImageData(frame, {
        modelBaseUrl: "/models/trustid",
        skipPad: true,
        rejectMultipleFaces: true,
      });
      if (!extracted.ok) {
        rejectSeq.current += 1;
        setRejected((r) => [
          ...r,
          {
            id: rejectSeq.current,
            reason: `FRAME_REJECTED reason=${extracted.code}`,
          },
        ]);
        setStatus(extracted.message);
        return;
      }
      if (extracted.payload.vector.length !== BIOMETRIC_AI_EMBEDDING_DIMS) {
        rejectSeq.current += 1;
        setRejected((r) => [
          ...r,
          {
            id: rejectSeq.current,
            reason: `FRAME_REJECTED reason=${BIOMETRIC_ERROR_CODES.EMBEDDING_FAILED}`,
          },
        ]);
        return;
      }

      // Optional active blink observation (not anti-spoof claim)
      padRef.current.observeBlendshapes(undefined);
      const jpeg = frameToJpegBase64(videoRef.current);

      await evalApi("/internal/biometric-eval/captures", secret, {
        method: "POST",
        body: JSON.stringify({
          subject_id: subjectId,
          sessionId,
          embedding: extracted.payload.vector,
          qualityScore: extracted.payload.confidence,
          active_liveness_check: "skipped",
          conditionTags: [sessionKey],
          imageBase64: jpeg ?? undefined,
          imageMime: jpeg ? "image/jpeg" : undefined,
        }),
      });
      setAccepted((n) => n + 1);
      setStatus(`Accepted frame ${accepted + 1}/3+`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Capture failed");
      rejectSeq.current += 1;
      setRejected((r) => [
        ...r,
        { id: rejectSeq.current, reason: "FRAME_REJECTED reason=UPLOAD_FAILED" },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function loadAdmin() {
    try {
      const data = await evalApi("/internal/biometric-eval/admin", secret);
      setAdmin(data);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Admin failed");
    }
  }

  async function exportDataset() {
    setBusy(true);
    try {
      const res = await evalApi<{
        relativePath: string;
        validation: { DATASET_VALID: boolean };
        BIOMETRIC_EVIDENCE_STATUS: string;
      }>("/internal/biometric-eval/export", secret, { method: "POST" });
      setStatus(
        `Export ${res.relativePath} ù DATASET_VALID=${res.validation.DATASET_VALID} ù ${res.BIOMETRIC_EVIDENCE_STATUS}`,
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  if (!unlocked) {
    return (
      <main style={{ maxWidth: 560, margin: "2rem auto", padding: 16, fontFamily: "system-ui" }}>
        <h1>INTERNAL BIOMETRIC EVALUATION</h1>
        <p>
          <strong>NOT FOR PRODUCTION ENROLLMENT</strong>
        </p>
        <p>Enter EVAL_BIOMETRIC_SECRET to continue.</p>
        <input
          type="password"
          value={secretInput}
          onChange={(e) => setSecretInput(e.target.value)}
          style={{ width: "100%", padding: 8 }}
        />
        <button type="button" onClick={() => void unlock()} style={{ marginTop: 12 }}>
          Unlock
        </button>
        {status ? <p>{status}</p> : null}
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 720, margin: "1.5rem auto", padding: 16, fontFamily: "system-ui" }}>
      <h1>INTERNAL BIOMETRIC EVALUATION</h1>
      <p>
        <strong>NOT FOR PRODUCTION ENROLLMENT</strong> ù PAD_STATUS = INCOMPLETE
        (blink ? anti-spoof)
      </p>

      {!subjectId ? (
        <section style={{ border: "1px solid #ccc", padding: 16, marginBottom: 16 }}>
          <h2>Consent</h2>
          <p>
            You are voluntarily contributing biometric face data to an internal Trust
            ID evaluation. Facial images and derived templates may be stored for
            accuracy/security testing only. Participation is not required for normal
            product use. You may decline.
          </p>
          <label>
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={(e) => setConsentChecked(e.target.checked)}
            />{" "}
            I consent to contribute evaluation biometric data
          </label>
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              disabled={!consentChecked || busy}
              onClick={() => void startParticipant()}
            >
              Start as evaluation participant
            </button>
          </div>
        </section>
      ) : (
        <section style={{ marginBottom: 16 }}>
          <p>
            Participant: <code>{subjectId}</code>
          </p>
          <p>
            Session: {sessionId ? <code>{sessionId}</code> : "none"} ù Accepted:{" "}
            {accepted} ù Rejected: {rejected.length}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" disabled={busy} onClick={() => void beginSession("enrollment_neutral")}>
              Session 1 Enrollment
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void beginSession("lighting_and_expression")}
            >
              Session 2 Lighting
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void beginSession("pose_and_distance")}
            >
              Session 3 Pose
            </button>
          </div>
          {guidance ? <p>{guidance}</p> : null}
          <video
            ref={videoRef}
            muted
            playsInline
            style={{ width: "100%", maxWidth: 480, background: "#111", marginTop: 12 }}
          />
          <div style={{ marginTop: 8 }}>
            <button type="button" disabled={busy || !sessionId} onClick={() => void captureOnce()}>
              Capture frame (production ArcFace pipeline)
            </button>
          </div>
          {rejected.length ? (
            <ul>
              {rejected.slice(-8).map((r) => (
                <li key={r.id}>{r.reason}</li>
              ))}
            </ul>
          ) : null}
        </section>
      )}

      <section style={{ borderTop: "1px solid #ddd", paddingTop: 16 }}>
        <h2>Admin / export</h2>
        <button type="button" onClick={() => void loadAdmin()}>
          Refresh dataset summary
        </button>{" "}
        <button type="button" disabled={busy} onClick={() => void exportDataset()}>
          Export labeled.json
        </button>
        {admin ? (
          <pre style={{ fontSize: 12, overflow: "auto" }}>
            {JSON.stringify(admin, null, 2)}
          </pre>
        ) : null}
      </section>
      {status ? <p>{status}</p> : null}
    </main>
  );
}

export default BiometricEvalCollectorPage;
