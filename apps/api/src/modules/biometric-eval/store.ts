/**
 * Filesystem store for INTERNAL biometric evaluation data.
 * Not a production identity database.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_ALIGNMENT_VERSION,
  BIOMETRIC_DETECTOR_VERSION,
  BIOMETRIC_PIPELINE_VERSION,
  BIOMETRIC_PREPROCESSING_VERSION,
} from "@trustid/shared";

export const EVAL_DATASET_NAME = "trustid_lab_v1";
export const EVAL_DATASET_VERSION = "1.0.0";
export const EVAL_MIN_ACCEPTED_PER_SESSION = 3;

export const EVAL_PIPELINE_RECORD = {
  modelName: BIOMETRIC_AI_MODEL_NAME,
  modelVersion: BIOMETRIC_AI_MODEL_VERSION,
  detectorVersion: BIOMETRIC_DETECTOR_VERSION,
  alignmentVersion: BIOMETRIC_ALIGNMENT_VERSION,
  preprocessingVersion: BIOMETRIC_PREPROCESSING_VERSION,
  pipelineVersion: BIOMETRIC_PIPELINE_VERSION,
  embeddingDims: BIOMETRIC_AI_EMBEDDING_DIMS,
  normalization: "L2",
  distanceMetric: "cosine_distance",
} as const;

export const EVAL_SESSION_PROTOCOL = [
  {
    key: "enrollment_neutral",
    title: "Session 1 ù Enrollment (neutral)",
    guidance:
      "Sit in normal indoor light. Look straight at the camera. Neutral expression. Capture at least 3 good frames.",
    conditionTags: ["neutral", "indoor_lighting"],
  },
  {
    key: "lighting_and_expression",
    title: "Session 2 ù Lighting / expression",
    guidance:
      "After a short break, vary lighting slightly and use a natural expression. At least 3 good frames.",
    conditionTags: ["lighting_variation", "expression_variation"],
  },
  {
    key: "pose_and_distance",
    title: "Session 3 ù Pose / distance",
    guidance:
      "After another break, change distance slightly and turn your head a little. Glasses on/off if applicable. At least 3 good frames.",
    conditionTags: ["pose_variation", "distance_variation"],
  },
] as const;

export type EvalSessionKey = (typeof EVAL_SESSION_PROTOCOL)[number]["key"];

export type EvalConsentRecord = {
  consent_given: true;
  consent_timestamp: string;
  dataset_version: string;
};

export type EvalCaptureRecord = {
  sampleId: string;
  subject_id: string;
  sessionId: string;
  sessionKey: EvalSessionKey;
  captureId: string;
  timestamp: string;
  qualityScore?: number;
  conditionTags?: string[];
  active_liveness_check?: "passed" | "skipped" | "failed";
  embedding: number[];
  imagePath?: string;
  imageSha256?: string;
  pipeline: typeof EVAL_PIPELINE_RECORD;
};

export type EvalParticipantMeta = {
  subject_id: string;
  created_at: string;
  consent: EvalConsentRecord;
  status: "active" | "deleted";
};

export type EvalManifest = {
  dataset_id: string;
  dataset_version: string;
  name: string;
  created_at: string;
  purpose: "INTERNAL_BIOMETRIC_EVALUATION_NOT_PRODUCTION_ENROLLMENT";
  pipeline: typeof EVAL_PIPELINE_RECORD;
  subject_count: number;
  session_count: number;
  image_count: number;
  capture_count: number;
  consented_participants: number;
};

function evalRoot(): string {
  const env = process.env.TRUSTID_EVAL_DATA_ROOT?.trim();
  if (env) return resolve(env);
  return resolve(process.cwd(), "artifacts/biometric-evaluation");
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) {
    throw Object.assign(new Error("Invalid id"), { statusCode: 400 });
  }
  return id;
}

function ensureDir(p: string) {
  mkdirSync(p, { recursive: true });
}

function writeJson(path: string, data: unknown) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function participantDir(subjectId: string) {
  return join(evalRoot(), "subjects", safeId(subjectId));
}

export function getEvalDataRoot(): string {
  return evalRoot();
}

export function ensureEvalStore(): EvalManifest {
  const root = evalRoot();
  ensureDir(join(root, "subjects"));
  ensureDir(join(root, "exports"));
  const manifestPath = join(root, "manifest.json");
  let manifest = readJson<EvalManifest>(manifestPath);
  if (!manifest) {
    manifest = {
      dataset_id: randomUUID(),
      dataset_version: EVAL_DATASET_VERSION,
      name: EVAL_DATASET_NAME,
      created_at: new Date().toISOString(),
      purpose: "INTERNAL_BIOMETRIC_EVALUATION_NOT_PRODUCTION_ENROLLMENT",
      pipeline: EVAL_PIPELINE_RECORD,
      subject_count: 0,
      session_count: 0,
      image_count: 0,
      capture_count: 0,
      consented_participants: 0,
    };
    writeJson(manifestPath, manifest);
  }
  return manifest;
}

export function refreshManifest(): EvalManifest {
  const root = evalRoot();
  ensureEvalStore();
  const subjects = readdirSync(join(root, "subjects"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let session_count = 0;
  let capture_count = 0;
  let image_count = 0;
  let consented = 0;

  for (const sid of subjects) {
    const meta = readJson<EvalParticipantMeta>(
      join(participantDir(sid), "meta.json"),
    );
    if (meta?.consent?.consent_given && meta.status !== "deleted") consented++;
    const sessionsDir = join(participantDir(sid), "sessions");
    if (!existsSync(sessionsDir)) continue;
    for (const sess of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!sess.isDirectory()) continue;
      session_count++;
      const capDir = join(sessionsDir, sess.name, "captures");
      if (existsSync(capDir)) {
        capture_count += readdirSync(capDir).filter((f) =>
          f.endsWith(".json"),
        ).length;
      }
      const imgDir = join(sessionsDir, sess.name, "images");
      if (existsSync(imgDir)) {
        image_count += readdirSync(imgDir).filter((x) =>
          /\.(png|jpe?g)$/i.test(x),
        ).length;
      }
    }
  }

  const prev = readJson<EvalManifest>(join(root, "manifest.json"))!;
  const next: EvalManifest = {
    ...prev,
    subject_count: subjects.filter((sid) => {
      const m = readJson<EvalParticipantMeta>(
        join(participantDir(sid), "meta.json"),
      );
      return m?.status !== "deleted";
    }).length,
    session_count,
    capture_count,
    image_count,
    consented_participants: consented,
    pipeline: EVAL_PIPELINE_RECORD,
  };
  writeJson(join(root, "manifest.json"), next);
  return next;
}

export function createParticipant(
  consent: EvalConsentRecord,
): EvalParticipantMeta {
  if (!consent.consent_given) {
    throw Object.assign(new Error("Consent required"), { statusCode: 400 });
  }
  ensureEvalStore();
  const subject_id = randomUUID().replace(/-/g, "");
  const meta: EvalParticipantMeta = {
    subject_id,
    created_at: new Date().toISOString(),
    consent: {
      consent_given: true,
      consent_timestamp: consent.consent_timestamp || new Date().toISOString(),
      dataset_version: consent.dataset_version || EVAL_DATASET_VERSION,
    },
    status: "active",
  };
  writeJson(join(participantDir(subject_id), "meta.json"), meta);
  refreshManifest();
  return meta;
}

export function getParticipant(subjectId: string): EvalParticipantMeta | null {
  return readJson<EvalParticipantMeta>(
    join(participantDir(subjectId), "meta.json"),
  );
}

export function requireConsentedParticipant(
  subjectId: string,
): EvalParticipantMeta {
  const meta = getParticipant(subjectId);
  if (!meta || meta.status === "deleted") {
    throw Object.assign(new Error("Participant not found"), { statusCode: 404 });
  }
  if (!meta.consent?.consent_given) {
    throw Object.assign(new Error("Consent required before capture"), {
      statusCode: 403,
      errorCode: "CONSENT_REQUIRED",
    });
  }
  return meta;
}

export function startSession(input: {
  subjectId: string;
  sessionKey: EvalSessionKey;
}): {
  sessionId: string;
  sessionKey: EvalSessionKey;
  title: string;
  guidance: string;
} {
  requireConsentedParticipant(input.subjectId);
  const proto = EVAL_SESSION_PROTOCOL.find((p) => p.key === input.sessionKey);
  if (!proto) {
    throw Object.assign(new Error("Unknown session key"), { statusCode: 400 });
  }
  const sessionId = randomUUID().replace(/-/g, "");
  const dir = join(participantDir(input.subjectId), "sessions", sessionId);
  ensureDir(join(dir, "captures"));
  ensureDir(join(dir, "images"));
  writeJson(join(dir, "meta.json"), {
    sessionId,
    sessionKey: input.sessionKey,
    subject_id: input.subjectId,
    started_at: new Date().toISOString(),
    title: proto.title,
    guidance: proto.guidance,
    conditionTags: proto.conditionTags,
  });
  refreshManifest();
  return {
    sessionId,
    sessionKey: input.sessionKey,
    title: proto.title,
    guidance: proto.guidance,
  };
}

export function storeCapture(input: {
  subjectId: string;
  sessionId: string;
  embedding: number[];
  qualityScore?: number;
  active_liveness_check?: "passed" | "skipped" | "failed";
  conditionTags?: string[];
  imageBase64?: string;
  imageMime?: string;
}): EvalCaptureRecord {
  const meta = requireConsentedParticipant(input.subjectId);
  const sessionDir = join(
    participantDir(input.subjectId),
    "sessions",
    safeId(input.sessionId),
  );
  if (!existsSync(join(sessionDir, "meta.json"))) {
    throw Object.assign(new Error("Session not found"), { statusCode: 404 });
  }
  const sessionMeta = readJson<{ sessionKey: EvalSessionKey }>(
    join(sessionDir, "meta.json"),
  )!;

  if (
    !Array.isArray(input.embedding) ||
    input.embedding.length !== EVAL_PIPELINE_RECORD.embeddingDims
  ) {
    throw Object.assign(new Error("Invalid embedding"), { statusCode: 400 });
  }

  const captureId = randomUUID().replace(/-/g, "");
  const sampleId = `${meta.subject_id}_${input.sessionId}_${captureId}`;
  let imagePath: string | undefined;
  let imageSha256: string | undefined;

  if (input.imageBase64) {
    const raw = input.imageBase64.replace(/^data:[^;]+;base64,/, "");
    const buf = Buffer.from(raw, "base64");
    if (buf.length > 2_500_000) {
      throw Object.assign(new Error("Image too large"), { statusCode: 413 });
    }
    const mime = input.imageMime ?? "image/png";
    if (mime !== "image/png" && mime !== "image/jpeg") {
      throw Object.assign(new Error("Invalid image type"), { statusCode: 400 });
    }
    const isPng =
      buf.length > 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47;
    const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
    if (mime === "image/png" && !isPng) {
      throw Object.assign(new Error("Invalid PNG"), { statusCode: 400 });
    }
    if (mime === "image/jpeg" && !isJpeg) {
      throw Object.assign(new Error("Invalid JPEG"), { statusCode: 400 });
    }
    imageSha256 = createHash("sha256").update(buf).digest("hex");
    // Reject identical image content reused across any session/subject
    for (const existing of listAllCaptures()) {
      if (existing.imageSha256 && existing.imageSha256 === imageSha256) {
        throw Object.assign(
          new Error("FRAME_REJECTED reason=DUPLICATE_IMAGE_HASH"),
          { statusCode: 409, errorCode: "DUPLICATE_IMAGE_HASH" },
        );
      }
    }
    const ext = mime === "image/jpeg" ? "jpg" : "png";
    const rel = `subjects/${meta.subject_id}/sessions/${input.sessionId}/images/${captureId}.${ext}`;
    const abs = join(evalRoot(), ...rel.split("/"));
    if (!abs.startsWith(evalRoot() + sep) && abs !== evalRoot()) {
      throw Object.assign(new Error("Bad path"), { statusCode: 400 });
    }
    ensureDir(dirname(abs));
    writeFileSync(abs, buf);
    imagePath = rel;
  }

  // Reject bit-identical embeddings re-used across sessions for same subject
  const embFp = input.embedding.map((x) => Number(x).toPrecision(12)).join(",");
  for (const existing of listAllCaptures()) {
    if (existing.subject_id !== meta.subject_id) continue;
    const prevFp = existing.embedding
      .map((x) => Number(x).toPrecision(12))
      .join(",");
    if (prevFp === embFp) {
      throw Object.assign(
        new Error("FRAME_REJECTED reason=DUPLICATE_EMBEDDING"),
        { statusCode: 409, errorCode: "DUPLICATE_EMBEDDING" },
      );
    }
  }

  const record: EvalCaptureRecord = {
    sampleId,
    subject_id: meta.subject_id,
    sessionId: input.sessionId,
    sessionKey: sessionMeta.sessionKey,
    captureId,
    timestamp: new Date().toISOString(),
    qualityScore: input.qualityScore,
    conditionTags: input.conditionTags,
    active_liveness_check: input.active_liveness_check,
    embedding: input.embedding,
    imagePath,
    imageSha256,
    pipeline: EVAL_PIPELINE_RECORD,
  };

  writeJson(join(sessionDir, "captures", `${captureId}.json`), record);
  refreshManifest();
  return record;
}

export function listParticipantProgress(subjectId: string) {
  const meta = getParticipant(subjectId);
  if (!meta || meta.status === "deleted") return null;
  const sessionsDir = join(participantDir(subjectId), "sessions");
  const sessions: Array<{
    sessionId: string;
    sessionKey: string;
    accepted: number;
    title?: string;
  }> = [];
  if (existsSync(sessionsDir)) {
    for (const d of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const sm = readJson<{ sessionKey: string; title?: string }>(
        join(sessionsDir, d.name, "meta.json"),
      );
      const capDir = join(sessionsDir, d.name, "captures");
      const accepted = existsSync(capDir)
        ? readdirSync(capDir).filter((f) => f.endsWith(".json")).length
        : 0;
      sessions.push({
        sessionId: d.name,
        sessionKey: sm?.sessionKey ?? "unknown",
        title: sm?.title,
        accepted,
      });
    }
  }
  return { meta, sessions, protocol: EVAL_SESSION_PROTOCOL };
}

export function listAllCaptures(): EvalCaptureRecord[] {
  const subjectsDir = join(evalRoot(), "subjects");
  if (!existsSync(subjectsDir)) return [];
  const out: EvalCaptureRecord[] = [];
  for (const sid of readdirSync(subjectsDir)) {
    const meta = getParticipant(sid);
    if (!meta || meta.status === "deleted") continue;
    const sessionsDir = join(participantDir(sid), "sessions");
    if (!existsSync(sessionsDir)) continue;
    for (const sess of readdirSync(sessionsDir)) {
      const capDir = join(sessionsDir, sess, "captures");
      if (!existsSync(capDir)) continue;
      for (const f of readdirSync(capDir)) {
        if (!f.endsWith(".json")) continue;
        const rec = readJson<EvalCaptureRecord>(join(capDir, f));
        if (rec) out.push(rec);
      }
    }
  }
  return out;
}

export function deleteParticipant(subjectId: string): void {
  const dir = participantDir(subjectId);
  if (!existsSync(dir)) {
    throw Object.assign(new Error("Not found"), { statusCode: 404 });
  }
  rmSync(dir, { recursive: true, force: true });
  // Invalidate stale export so deleted biometrics cannot remain in labeled.json
  const exportPath = join(evalRoot(), "exports", "labeled.json");
  if (existsSync(exportPath)) {
    rmSync(exportPath, { force: true });
  }
  refreshManifest();
}

export function adminSummary() {
  const manifest = refreshManifest();
  const subjectsDir = join(evalRoot(), "subjects");
  const participants: Array<{
    subject_id: string;
    sessions: number;
    captures: number;
    consented: boolean;
  }> = [];
  if (existsSync(subjectsDir)) {
    for (const sid of readdirSync(subjectsDir)) {
      const prog = listParticipantProgress(sid);
      if (!prog) continue;
      participants.push({
        subject_id: sid,
        sessions: prog.sessions.length,
        captures: prog.sessions.reduce((n, s) => n + s.accepted, 0),
        consented: Boolean(prog.meta.consent?.consent_given),
      });
    }
  }
  return { manifest, participants, protocol: EVAL_SESSION_PROTOCOL };
}
