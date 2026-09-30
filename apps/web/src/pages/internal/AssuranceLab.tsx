/**
 * TRUSTID ASSURANCE LAB - development-only dashboard.
 *
 * Routed only when import.meta.env.DEV is true. Collects consented,
 * pseudonymous evaluation evidence through the production face pipeline.
 * Frames are processed in memory and cleared by the pipeline; no image is
 * uploaded. Production configuration is displayed read-only: there is no
 * control here (or in the lab API) that changes production.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { BIOMETRIC_ERROR_CODES, BIOMETRIC_PIPELINE_VERSION } from "@trustid/shared";
import { extractFaceEmbeddingFromImageData } from "@trustid/sdk";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";
const PREFIX = "/internal/assurance-lab";
const SECRET_KEY = "trustid_assurance_lab_secret";
const CONSENT_PHRASE = "I CONSENT";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function labApi<T = Json>(path: string, secret: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${PREFIX}${path}`, {
    method: init.method ?? "GET",
    credentials: "omit",
    headers: { "Content-Type": "application/json", "x-assurance-lab-secret": secret },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ? `${data.error}${data.message ? `: ${data.message}` : ""}` : res.statusText);
  return data as T;
}

function detectRuntime(): string {
  const ua = navigator.userAgent;
  if (/; wv\)/.test(ua)) return "ANDROID_WEBVIEW";
  if (/SamsungBrowser/.test(ua)) return "SAMSUNG_INTERNET";
  if (/Edg\//.test(ua)) return "EDGE";
  if (/Firefox\//.test(ua)) return "FIREFOX";
  if (/Chrome\//.test(ua)) return "CHROME";
  if (/iPhone|iPad/.test(ua) && !/Safari\//.test(ua)) return "WKWEBVIEW";
  if (/Safari\//.test(ua)) return "SAFARI";
  return "OTHER";
}

function detectDeviceClass(): string {
  const ua = navigator.userAgent;
  if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return "TABLET";
  if (/Mobi|iPhone|Android/.test(ua)) return "PHONE";
  return "LAPTOP_DESKTOP";
}

function grabFrame(video: HTMLVideoElement): ImageData | null {
  if (!video.videoWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0);
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0;
  canvas.height = 0;
  return frame;
}

const fmt = (x: unknown, digits = 4) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(digits) : "-");

const panel = (color: string) => ({
  border: `2px solid ${color}`,
  borderRadius: 8,
  padding: 16,
  marginBottom: 16,
});

function Histogram({ bins, production, candidate }: { bins: Json[]; production: number; candidate: number | null }) {
  if (!bins?.length) return <p>No comparisons yet.</p>;
  const w = 640;
  const h = 160;
  const lo = bins[0].lo as number;
  const hi = bins[bins.length - 1].hi as number;
  const x = (d: number) => ((d - lo) / (hi - lo)) * w;
  const max = Math.max(1, ...bins.map((b) => Math.max(b.genuine, b.impostor)));
  const bw = w / bins.length;
  return (
    <svg viewBox={`0 0 ${w} ${h + 20}`} style={{ width: "100%", maxWidth: w }} role="img" aria-label="Distance histogram">
      {bins.map((b, i) => (
        <g key={i}>
          <rect x={i * bw} y={h - (b.genuine / max) * h} width={bw / 2} height={(b.genuine / max) * h} fill="#2e7d32" />
          <rect x={i * bw + bw / 2} y={h - (b.impostor / max) * h} width={bw / 2} height={(b.impostor / max) * h} fill="#c62828" />
        </g>
      ))}
      {production >= lo && production <= hi ? (
        <line x1={x(production)} x2={x(production)} y1={0} y2={h} stroke="#1565c0" strokeWidth={2} />
      ) : null}
      {candidate != null && candidate >= lo && candidate <= hi ? (
        <line x1={x(candidate)} x2={x(candidate)} y1={0} y2={h} stroke="#ef6c00" strokeDasharray="4 3" strokeWidth={2} />
      ) : null}
      <text x={0} y={h + 16} fontSize={11}>{lo.toFixed(2)}</text>
      <text x={w - 30} y={h + 16} fontSize={11}>{hi.toFixed(2)}</text>
    </svg>
  );
}

export function AssuranceLabPage() {
  const [secret, setSecret] = useState(() => sessionStorage.getItem(SECRET_KEY) ?? "");
  const [secretInput, setSecretInput] = useState("");
  const [status, setStatus] = useState<Json | null>(null);
  const [consentDoc, setConsentDoc] = useState<Json | null>(null);
  const [phrase, setPhrase] = useState("");
  const [cohort, setCohort] = useState("GALLERY");
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [session, setSession] = useState<Json | null>(null);
  const [sessionKey, setSessionKey] = useState("SESSION_A");
  const [stepKey, setStepKey] = useState("");
  const [conditions, setConditions] = useState<string[]>([]);
  const [env, setEnv] = useState(() => ({
    platform: "WEB",
    runtime: detectRuntime(),
    deviceClass: detectDeviceClass(),
    cameraFacing: "USER",
    cameraOrientation: window.innerHeight > window.innerWidth ? "PORTRAIT" : "LANDSCAPE",
    inferenceBackend: "UNKNOWN",
  }));
  const [padPresentation, setPadPresentation] = useState("BONA_FIDE_LIVE");
  const [report, setReport] = useState<Json | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const note = (m: string) => setLog((l) => [...l.slice(-11), `${new Date().toLocaleTimeString()}  ${m}`]);
  const protocol: Json[] = status?.lab?.protocol ?? [];
  const activeSessionKey: string = session?.protocolSessionKey ?? sessionKey;
  const steps: Json[] = useMemo(
    () => protocol.find((s) => s.key === activeSessionKey)?.steps ?? [],
    [protocol, activeSessionKey],
  );
  const step = steps.find((s) => s.key === stepKey);

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);
  useEffect(() => {
    if (secret) void load(secret);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function load(s: string) {
    try {
      const [st, doc] = await Promise.all([labApi("/status", s), labApi("/consent", s)]);
      sessionStorage.setItem(SECRET_KEY, s);
      setSecret(s);
      setStatus(st);
      setConsentDoc(doc);
    } catch (err) {
      sessionStorage.removeItem(SECRET_KEY);
      setSecret("");
      note(err instanceof Error ? err.message : "Unauthorized");
    }
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      note(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const recordConsent = () =>
    run("Consent", async () => {
      const res = await labApi("/participants", secret, {
        method: "POST",
        body: { phrase, consentVersion: consentDoc?.document?.consentVersion, cohort },
      });
      setParticipantId(res.participant.participantId);
      setPhrase("");
      note(`Consent recorded for pseudonym ${res.participant.participantId}`);
    });

  const withdraw = () =>
    run("Withdraw", async () => {
      if (!participantId || !window.confirm("Withdraw this participant and delete all of their lab evidence?")) return;
      const res = await labApi(`/participants/${participantId}/withdraw`, secret, { method: "POST" });
      note(`Withdrawn; deleted ${JSON.stringify(res.withdrawal.deleted)}`);
      setParticipantId(null);
      setSession(null);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    });

  const startSession = () =>
    run("Session", async () => {
      const res = await labApi("/sessions", secret, {
        method: "POST",
        body: { participantId, protocolSessionKey: sessionKey, environment: env },
      });
      setSession(res.session);
      setStepKey("");
      setConditions([]);
      if (res.protocolWarnings?.length) note(`Protocol warning: ${res.protocolWarnings.join("; ")}`);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: env.cameraFacing === "ENVIRONMENT" ? "environment" : "user", width: { ideal: 640 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      note(`Session ${res.session.protocolSessionKey} started`);
    });

  const capture = () =>
    run("Capture", async () => {
      if (!session || !videoRef.current || !step || !conditions.length) return;
      const t0 = performance.now();
      const frame = grabFrame(videoRef.current);
      const result = frame
        ? await extractFaceEmbeddingFromImageData(frame, { modelBaseUrl: "/models/trustid", skipPad: true })
        : null;
      const total = performance.now() - t0;
      const ok = result?.ok === true;
      const model = ok
        ? {
            name: result.payload.modelName,
            version: result.payload.modelVersion,
            embeddingDimensions: result.payload.vector.length,
            detectorVersion: result.payload.detectorVersion,
            alignmentVersion: result.payload.alignmentVersion,
            preprocessingVersion: result.payload.preprocessingVersion,
            pipelineVersion: BIOMETRIC_PIPELINE_VERSION,
          }
        : status?.productionModel;
      await labApi("/captures", secret, {
        method: "POST",
        body: {
          sessionId: session.sessionId,
          protocolStepKey: step.key,
          conditions,
          model: {
            name: model.name,
            version: model.version,
            embeddingDimensions: model.embeddingDimensions,
            detectorVersion: model.detectorVersion,
            alignmentVersion: model.alignmentVersion,
            preprocessingVersion: model.preprocessingVersion,
            pipelineVersion: model.pipelineVersion,
          },
          quality: ok
            ? { decision: "PASS", score: result.quality.score }
            : { decision: "REJECT", reasons: [result && !result.ok ? result.code : "NO_FRAME"] },
          pad: { decision: "NOT_RUN", method: "skipped_for_recognition_capture" },
          latencyMs: { total },
          embedding: ok ? result.payload.vector : null,
        },
      });
      note(ok ? `Accepted ${step.key} [${conditions.join(",")}]` : `Rejected (failure to acquire): ${result && !result.ok ? result.code : "NO_FRAME"}`);
    });

  const recordPad = () =>
    run("PAD", async () => {
      if (!session || !videoRef.current) return;
      const frame = grabFrame(videoRef.current);
      const result = frame ? await extractFaceEmbeddingFromImageData(frame, { modelBaseUrl: "/models/trustid", skipPad: false }) : null;
      const code = result && !result.ok ? result.code : null;
      const message = result && !result.ok ? result.message : "";
      const padDecision = result?.ok
        ? "PASS"
        : code === BIOMETRIC_ERROR_CODES.LIVENESS_FAILED
          ? /unavailable|not available|requires/i.test(message) ? "UNAVAILABLE" : "REJECT"
          : "NOT_RUN";
      await labApi("/pad-attempts", secret, {
        method: "POST",
        body: {
          sessionId: session.sessionId,
          presentation: padPresentation,
          padDecision,
          padMethod: "production_single_frame_pad",
          challengeResult: "NOT_ISSUED",
          qualityDecision: result?.ok || code === BIOMETRIC_ERROR_CODES.LIVENESS_FAILED ? "PASS" : "REJECT",
        },
      });
      note(`PAD attempt ${padPresentation}: ${padDecision}${code ? ` (${code})` : ""}`);
    });

  const loadReport = () =>
    run("Report", async () => {
      const res = await labApi("/report", secret);
      setReport(res.report);
    });

  const downloadExport = () =>
    run("Export", async () => {
      const res = await fetch(`${API_BASE}${PREFIX}/export`, { headers: { "x-assurance-lab-secret": secret }, credentials: "omit" });
      if (!res.ok) throw new Error(res.statusText);
      const blob = new Blob([await res.text()], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "trustid-assurance-lab-export.json";
      a.click();
      URL.revokeObjectURL(a.href);
    });

  if (!status) {
    return (
      <main style={{ maxWidth: 560, margin: "2rem auto", padding: 16, fontFamily: "system-ui" }}>
        <h1>TrustID Assurance Lab</h1>
        <p><strong>DEVELOPMENT / TESTING ONLY - EVALUATION RESULTS, NOT AUTHENTICATION</strong></p>
        <input type="password" placeholder="TRUSTID_ASSURANCE_LAB_SECRET" value={secretInput} onChange={(e) => setSecretInput(e.target.value)} style={{ width: "100%", padding: 8 }} />
        <button type="button" onClick={() => void load(secretInput)} style={{ marginTop: 12 }}>Unlock</button>
        {log.map((l) => <p key={l}>{l}</p>)}
      </main>
    );
  }

  const prod = status.productionConfiguration;
  const rec = report?.recommendation;
  const set = <K extends keyof typeof env>(k: K, v: string) => setEnv((e) => ({ ...e, [k]: v }));
  const select = (k: keyof typeof env, values: string[]) => (
    <label style={{ marginRight: 12 }}>
      {k}{" "}
      <select value={env[k]} disabled={!!session} onChange={(e) => set(k, e.target.value)}>
        {values.map((v) => <option key={v}>{v}</option>)}
      </select>
    </label>
  );

  return (
    <main style={{ maxWidth: 980, margin: "1rem auto", padding: 16, fontFamily: "system-ui" }}>
      <h1>TrustID Assurance Lab</h1>
      <p><strong>DEVELOPMENT / TESTING ONLY.</strong> Every result here is an EVALUATION_RESULT. It never signs anyone in, never creates a TrustID, and grants no authority.</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <section style={panel("#1565c0")}>
          <h2 style={{ marginTop: 0 }}>PRODUCTION CONFIGURATION (read-only)</h2>
          <p>Threshold (cosine distance): <strong>{prod.thresholdDistance}</strong> - status <strong>{prod.thresholdStatus}</strong></p>
          <p>Ambiguity margin: {prod.ambiguityMarginDistance} | PAD: {prod.padStatus}</p>
          <p>Runtime override {prod.runtimeOverride.variable}: {prod.runtimeOverride.present ? "PRESENT" : "not set"}</p>
          <p>Model: {status.productionModel.name} v{status.productionModel.version} ({status.productionModel.embeddingDimensions}-D, L2, cosine)</p>
          <p style={{ fontSize: 13 }}>The lab cannot change production. Any threshold change requires governance review and a separate code change.</p>
        </section>
        <section style={panel("#ef6c00")}>
          <h2 style={{ marginTop: 0 }}>LAB RECOMMENDATION (not applied)</h2>
          {!rec ? <p>Load the report to see the lab analysis.</p> : rec.status === "CANDIDATE_THRESHOLD" ? (
            <>
              <p>Candidate threshold: <strong>{rec.candidateThresholdDistance}</strong> (governance review required; applies to production: NO)</p>
              <p>Dev FMR {fmt(rec.developmentMetrics?.fmr, 6)} (95% upper {fmt(rec.developmentMetrics?.fmrCi95High, 6)}) - Validation FMR {fmt(rec.validationMetrics?.fmr, 6)}, FNMR {fmt(rec.validationMetrics?.fnmr)}</p>
            </>
          ) : (
            <>
              <p><strong>THRESHOLD RECOMMENDATION - {rec.status === "SYNTHETIC_NOT_ELIGIBLE" ? "SYNTHETIC EVIDENCE NOT ELIGIBLE" : "INSUFFICIENT EVIDENCE"}</strong></p>
              <ul>{rec.unmetGates.map((g: string) => <li key={g}>{g}</li>)}</ul>
            </>
          )}
        </section>
      </div>

      <section style={panel("#555")}>
        <h2 style={{ marginTop: 0 }}>Consent ceremony</h2>
        {participantId ? (
          <p>Participant pseudonym: <code>{participantId}</code> <button type="button" disabled={busy} onClick={() => void withdraw()}>Withdraw and delete</button></p>
        ) : (
          <>
            <h3>{consentDoc?.document?.title}</h3>
            {consentDoc?.document?.sections?.map((s: Json) => (
              <p key={s.heading}><strong>{s.heading}.</strong> {s.body}</p>
            ))}
            <p style={{ fontSize: 12 }}>Consent version {consentDoc?.document?.consentVersion} - document SHA-256 {consentDoc?.documentSha256?.slice(0, 16)}...</p>
            <label>Type <code>{CONSENT_PHRASE}</code> to agree: <input value={phrase} onChange={(e) => setPhrase(e.target.value)} /></label>{" "}
            <select value={cohort} onChange={(e) => setCohort(e.target.value)}>
              <option value="GALLERY">GALLERY</option>
              <option value="OPEN_SET_HOLDOUT">OPEN_SET_HOLDOUT (never enrolled; tests NO_MATCH)</option>
            </select>{" "}
            <button type="button" disabled={busy || phrase.trim() !== CONSENT_PHRASE} onClick={() => void recordConsent()}>Record consent</button>
          </>
        )}
      </section>

      {participantId ? (
        <section style={panel("#555")}>
          <h2 style={{ marginTop: 0 }}>Session and capture</h2>
          <div style={{ marginBottom: 8 }}>
            {select("platform", ["WEB", "ANDROID", "IOS"])}
            {select("runtime", ["SAFARI", "CHROME", "EDGE", "FIREFOX", "SAMSUNG_INTERNET", "ANDROID_WEBVIEW", "WKWEBVIEW", "OTHER"])}
            {select("deviceClass", ["PHONE", "TABLET", "LAPTOP_DESKTOP", "UNKNOWN"])}
            {select("cameraFacing", ["USER", "ENVIRONMENT", "EXTERNAL", "UNKNOWN"])}
            {select("cameraOrientation", ["PORTRAIT", "LANDSCAPE", "UNKNOWN"])}
            {select("inferenceBackend", ["WEBGPU", "WASM", "WEBGL", "NATIVE", "UNKNOWN"])}
          </div>
          <label>Protocol session{" "}
            <select value={sessionKey} onChange={(e) => setSessionKey(e.target.value)}>
              {protocol.map((s) => <option key={s.key} value={s.key}>{s.title}</option>)}
            </select>
          </label>{" "}
          <button type="button" disabled={busy} onClick={() => void startSession()}>Start session</button>
          {session ? (
            <>
              <p>{protocol.find((s) => s.key === session.protocolSessionKey)?.guidance}</p>
              <video ref={videoRef} muted playsInline style={{ width: "100%", maxWidth: 480, background: "#111" }} />
              <div>
                <label>Step{" "}
                  <select value={stepKey} onChange={(e) => { setStepKey(e.target.value); setConditions([]); }}>
                    <option value="">-- choose --</option>
                    {steps.map((s: Json) => (
                      <option key={s.key} value={s.key}>{s.title} (target {s.targetCaptures})</option>
                    ))}
                  </select>
                </label>
                {step ? <p>{step.guidance}</p> : null}
                {step?.allowedConditions.map((c: string) => (
                  <label key={c} style={{ marginRight: 12 }}>
                    <input type="checkbox" checked={conditions.includes(c)} onChange={(e) => setConditions((cs) => (e.target.checked ? [...cs, c] : cs.filter((x) => x !== c)))} /> {c}
                  </label>
                ))}
              </div>
              <button type="button" disabled={busy || !step || !conditions.length} onClick={() => void capture()}>Capture (production pipeline, frame discarded)</button>
              <div style={{ marginTop: 12 }}>
                <label>PAD presentation (operator-prepared){" "}
                  <select value={padPresentation} onChange={(e) => setPadPresentation(e.target.value)}>
                    {["BONA_FIDE_LIVE", "STATIC_PHOTO", "SCREEN_DISPLAY", "PRERECORDED_VIDEO"].map((p) => <option key={p}>{p}</option>)}
                  </select>
                </label>{" "}
                <button type="button" disabled={busy} onClick={() => void recordPad()}>Record PAD attempt</button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      <section style={panel("#555")}>
        <h2 style={{ marginTop: 0 }}>Evaluation report</h2>
        <button type="button" disabled={busy} onClick={() => void loadReport()}>Load / refresh report</button>{" "}
        <button type="button" disabled={busy} onClick={() => void downloadExport()}>Download aggregate export</button>
        {report ? (
          <div style={{ fontSize: 14 }}>
            <p>Evidence: {report.evidence.evidenceClass} - {report.evidence.participants} participants, {report.evidence.sessions} sessions, {report.evidence.captures} captures ({report.evidence.comparableCaptures} comparable; FTA {fmt(report.evidence.failureToAcquire.rate, 3)})</p>
            <p>Pairs: {report.evidence.genuinePairs} genuine, {report.evidence.impostorPairs} impostor ({report.evidence.impostorSampling.method})</p>
            <p>Genuine distance p50 {fmt(report.recognition.genuineDistance.p50)} / p95 {fmt(report.recognition.genuineDistance.p95)} - Impostor p05 {fmt(report.recognition.impostorDistance.p05)} / p50 {fmt(report.recognition.impostorDistance.p50)}</p>
            <Histogram bins={report.recognition.histogram.bins} production={prod.thresholdDistance} candidate={rec?.candidateThresholdDistance ?? null} />
            <p style={{ fontSize: 12 }}>Green: genuine, red: impostor, blue: production threshold, orange dashed: lab candidate (if any).</p>
            <p>At production threshold: FMR {fmt(report.recognition.atProductionThreshold?.fmr, 6)} - FNMR {fmt(report.recognition.atProductionThreshold?.fnmr)} - EER {report.recognition.roc.eerStatus === "MEASURED" ? fmt(report.recognition.roc.eer) : report.recognition.roc.eerStatus}</p>
            <p>1:N ({report.identification.retrievalMode}, gallery {report.identification.gallerySize}): closed-set {JSON.stringify(report.identification.closedSet.outcomes)}; open-set {JSON.stringify(report.identification.openSet.outcomes)}</p>
            <p>Duplicate enrollment: returning flagged {report.duplicateEnrollment.returningFlagged}/{report.duplicateEnrollment.returningAttempts}, new CLEAR {report.duplicateEnrollment.newClear}/{report.duplicateEnrollment.newAttempts}, outage fails closed: {String(report.duplicateEnrollment.serviceUnavailableFailClosed)}</p>
            <p>PAD: {report.pad.status} (production-ready: NO) - BPCER {fmt(report.pad.bonaFide.bpcer, 3)}, max APCER {fmt(report.pad.maxApcer, 3)}</p>
            <p>Statuses: {JSON.stringify(report.statuses)}</p>
          </div>
        ) : null}
      </section>

      <section>
        {log.map((l, i) => <div key={i} style={{ fontFamily: "monospace", fontSize: 12 }}>{l}</div>)}
      </section>
    </main>
  );
}

export default AssuranceLabPage;
