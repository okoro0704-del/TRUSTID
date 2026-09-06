/**
 * Validate a labeled.json biometric evaluation dataset (DATASET_SPEC.md).
 * Pure functions ù no Node fs ù so browser/tests can share logic.
 */
import {
  BIOMETRIC_AI_EMBEDDING_DIMS,
  BIOMETRIC_AI_MODEL_NAME,
  BIOMETRIC_AI_MODEL_VERSION,
  BIOMETRIC_PIPELINE_VERSION,
} from "@trustid/shared";
import { EVAL_MIN_ACCEPTED_PER_SESSION } from "./store.js";

export type DatasetValidationIssue = {
  code: string;
  message: string;
  path?: string;
};

export type DatasetValidationResult = {
  DATASET_VALID: boolean;
  errors: DatasetValidationIssue[];
  warnings: DatasetValidationIssue[];
  stats: {
    subjects: number;
    samples: number;
    sessions: number;
    splits: Record<string, number>;
  };
};

type RawSample = Record<string, unknown>;

function subjectOf(s: RawSample): string {
  return String(s.subject_id ?? s.subjectId ?? s.identityId ?? "");
}

function splitOf(s: RawSample): string {
  return String(s.split ?? "").toLowerCase();
}

export function validateLabeledDatasetJson(
  raw: unknown,
  options: {
    requireImagePath?: boolean;
    requireMinSessions?: boolean;
    checkFileExists?: (relativePath: string) => boolean;
  } = {},
): DatasetValidationResult {
  const errors: DatasetValidationIssue[] = [];
  const warnings: DatasetValidationIssue[] = [];

  if (!raw || typeof raw !== "object") {
    return {
      DATASET_VALID: false,
      errors: [{ code: "NOT_OBJECT", message: "Dataset must be a JSON object" }],
      warnings: [],
      stats: { subjects: 0, samples: 0, sessions: 0, splits: {} },
    };
  }

  const obj = raw as Record<string, unknown>;
  const samples = obj.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    errors.push({
      code: "NO_SAMPLES",
      message: "samples must be a non-empty array",
    });
  }

  const modelName = String(obj.modelName ?? "");
  const modelVersion = Number(obj.modelVersion);
  if (modelName && modelName !== BIOMETRIC_AI_MODEL_NAME) {
    errors.push({
      code: "MODEL_MISMATCH",
      message: `modelName must be ${BIOMETRIC_AI_MODEL_NAME} for TrustID accuracy claims`,
    });
  }
  if (
    Number.isFinite(modelVersion) &&
    modelVersion !== BIOMETRIC_AI_MODEL_VERSION
  ) {
    errors.push({
      code: "MODEL_VERSION_MISMATCH",
      message: `modelVersion must be ${BIOMETRIC_AI_MODEL_VERSION}`,
    });
  }
  if (
    obj.pipelineVersion != null &&
    String(obj.pipelineVersion) !== BIOMETRIC_PIPELINE_VERSION
  ) {
    warnings.push({
      code: "PIPELINE_VERSION_DIFFERS",
      message: `pipelineVersion ${String(obj.pipelineVersion)} differs from ${BIOMETRIC_PIPELINE_VERSION}`,
    });
  }

  const subjectSamples = new Map<string, RawSample[]>();
  const sampleIds = new Set<string>();
  const imagePaths = new Set<string>();
  const imageHashes = new Map<string, string>();
  const embeddingFingerprints = new Map<string, string>();
  const sessionOwners = new Map<string, string>();
  const splits: Record<string, number> = {};
  const sessionKeys = new Set<string>();
  const list = Array.isArray(samples) ? samples : [];

  // Consent attestation (collector exports)
  const consentBlock = obj.consent_attestation;
  const consentedSubjects = new Set<string>();
  if (consentBlock && typeof consentBlock === "object") {
    const participants = (consentBlock as { participants?: unknown })
      .participants;
    if (!Array.isArray(participants) || participants.length === 0) {
      errors.push({
        code: "CONSENT_ATTESTATION_EMPTY",
        message: "consent_attestation.participants must be a non-empty array",
      });
    } else {
      for (const p of participants) {
        if (!p || typeof p !== "object") continue;
        const row = p as Record<string, unknown>;
        const sid = String(row.subject_id ?? "");
        if (!sid || row.consent_given !== true) {
          errors.push({
            code: "CONSENT_INVALID",
            message: `consent row missing subject_id or consent_given=true`,
          });
          continue;
        }
        if (!row.consent_timestamp) {
          errors.push({
            code: "CONSENT_TIMESTAMP_MISSING",
            message: `consent_timestamp missing for ${sid}`,
          });
        }
        consentedSubjects.add(sid);
      }
    }
  } else if (list.length > 0) {
    warnings.push({
      code: "CONSENT_ATTESTATION_MISSING",
      message:
        "consent_attestation absent; collector exports should include it",
    });
  }

  for (let i = 0; i < list.length; i++) {
    const s = list[i] as RawSample;
    const pathPrefix = `samples[${i}]`;
    const sid = subjectOf(s);
    if (!sid) {
      errors.push({
        code: "MISSING_SUBJECT_ID",
        message: "subject_id / identityId required",
        path: pathPrefix,
      });
    }
    const sampleId = String(
      s.sampleId ?? s.captureId ?? (sid ? `${sid}_${i}` : `unknown_${i}`),
    );
    if (sampleIds.has(sampleId)) {
      errors.push({
        code: "DUPLICATE_SAMPLE_ID",
        message: `duplicate sampleId ${sampleId}`,
        path: pathPrefix,
      });
    }
    sampleIds.add(sampleId);

    const emb = s.embedding;
    if (!Array.isArray(emb) || emb.length !== BIOMETRIC_AI_EMBEDDING_DIMS) {
      errors.push({
        code: "BAD_EMBEDDING",
        message: `embedding must be length ${BIOMETRIC_AI_EMBEDDING_DIMS}`,
        path: pathPrefix,
      });
    } else if (emb.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
      errors.push({
        code: "BAD_EMBEDDING_VALUES",
        message: "embedding must be finite numbers",
        path: pathPrefix,
      });
    } else {
      // Exact duplicate embedding detection (bit-identical float sequence)
      const fp = emb.map((x) => Number(x).toPrecision(12)).join(",");
      const prevEmb = embeddingFingerprints.get(fp);
      if (prevEmb && prevEmb !== sampleId) {
        errors.push({
          code: "DUPLICATE_EMBEDDING",
          message: `identical embedding shared by ${prevEmb} and ${sampleId}`,
          path: pathPrefix,
        });
      }
      embeddingFingerprints.set(fp, sampleId);
    }

    const split = splitOf(s);
    if (!["development", "validation", "test"].includes(split)) {
      errors.push({
        code: "BAD_SPLIT",
        message: "split must be development|validation|test",
        path: pathPrefix,
      });
    } else {
      splits[split] = (splits[split] ?? 0) + 1;
    }

    const img =
      typeof s.imagePath === "string"
        ? s.imagePath
        : typeof s.path === "string"
          ? s.path
          : "";
    if (options.requireImagePath && !img) {
      errors.push({
        code: "MISSING_IMAGE_PATH",
        message: "imagePath required when requireImagePath is set",
        path: pathPrefix,
      });
    }
    if (img) {
      if (img.includes("..") || img.startsWith("/") || /^[a-zA-Z]:/.test(img)) {
        errors.push({
          code: "UNSAFE_IMAGE_PATH",
          message: "imagePath must be a relative safe path",
          path: pathPrefix,
        });
      }
      if (imagePaths.has(img)) {
        errors.push({
          code: "DUPLICATE_IMAGE_PATH",
          message: `duplicate imagePath ${img}`,
          path: pathPrefix,
        });
      }
      imagePaths.add(img);
      if (options.checkFileExists && !options.checkFileExists(img)) {
        errors.push({
          code: "MISSING_IMAGE_FILE",
          message: `image file missing: ${img}`,
          path: pathPrefix,
        });
      }
    }

    const hash =
      typeof s.imageSha256 === "string" ? s.imageSha256.toLowerCase() : "";
    if (hash) {
      const prev = imageHashes.get(hash);
      if (prev && prev !== sampleId) {
        errors.push({
          code: "DUPLICATE_IMAGE_HASH",
          message: `identical image hash shared by ${prev} and ${sampleId}`,
          path: pathPrefix,
        });
      }
      imageHashes.set(hash, sampleId);
    }

    const sessionId = String(s.sessionId ?? "");
    if (sessionId && sid) {
      const owner = sessionOwners.get(sessionId);
      if (owner && owner !== sid) {
        errors.push({
          code: "DUPLICATE_SESSION_ID",
          message: `sessionId ${sessionId} claimed by subjects ${owner} and ${sid}`,
          path: pathPrefix,
        });
      }
      sessionOwners.set(sessionId, sid);
      sessionKeys.add(`${sid}::${sessionId}`);
    }

    if (!sid) continue;

    if (consentedSubjects.size > 0 && !consentedSubjects.has(sid)) {
      errors.push({
        code: "CONSENT_SUBJECT_MISSING",
        message: `subject ${sid} appears in samples without consent_attestation`,
        path: pathPrefix,
      });
    }

    const arr = subjectSamples.get(sid) ?? [];
    arr.push(s);
    subjectSamples.set(sid, arr);
  }

  if (consentedSubjects.size > 0) {
    for (const sid of consentedSubjects) {
      if (!subjectSamples.has(sid)) {
        warnings.push({
          code: "CONSENT_ORPHAN_SUBJECT",
          message: `consent listed for ${sid} but no samples present`,
        });
      }
    }
  }

  // Subject-disjoint splits: a subject must not appear in more than one split
  for (const [sid, rows] of subjectSamples) {
    const subjectSplits = new Set(rows.map(splitOf).filter(Boolean));
    if (subjectSplits.size > 1) {
      errors.push({
        code: "SUBJECT_SPLIT_LEAKAGE",
        message: `subject ${sid} appears in multiple splits: ${[...subjectSplits].join(",")}`,
      });
    }

    if (options.requireMinSessions !== false) {
      const sessions = new Set(
        rows.map((r) => String(r.sessionId ?? "")).filter(Boolean),
      );
      if (sessions.size > 0 && sessions.size < 3) {
        warnings.push({
          code: "FEW_SESSIONS",
          message: `subject ${sid} has ${sessions.size} sessions; protocol recommends ?3`,
        });
      }
      for (const sess of sessions) {
        const n = rows.filter((r) => String(r.sessionId ?? "") === sess).length;
        if (n < EVAL_MIN_ACCEPTED_PER_SESSION) {
          warnings.push({
            code: "FEW_CAPTURES_IN_SESSION",
            message: `subject ${sid} session ${sess} has ${n} samples; recommend ?${EVAL_MIN_ACCEPTED_PER_SESSION}`,
          });
        }
      }
    }
  }

  return {
    DATASET_VALID: errors.length === 0,
    errors,
    warnings,
    stats: {
      subjects: subjectSamples.size,
      samples: list.length,
      sessions: sessionKeys.size,
      splits,
    },
  };
}

/**
 * Assign subject-disjoint splits. Never split frames from the same subject
 * across development/validation/test.
 */
export function assignSubjectDisjointSplits(
  subjectIds: string[],
  ratios = { development: 0.5, validation: 0.2, test: 0.3 },
  seed = 42,
): Map<string, "development" | "validation" | "test"> {
  const ids = [...subjectIds].sort();
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = ids[i]!;
    ids[i] = ids[j]!;
    ids[j] = tmp;
  }
  const n = ids.length;
  const nDev = Math.max(1, Math.floor(n * ratios.development));
  const nVal = Math.max(0, Math.floor(n * ratios.validation));
  const out = new Map<string, "development" | "validation" | "test">();
  ids.forEach((id, i) => {
    if (i < nDev) out.set(id, "development");
    else if (i < nDev + nVal) out.set(id, "validation");
    else out.set(id, "test");
  });
  // Ensure at least one test subject when n>=2
  if (n >= 2 && ![...out.values()].includes("test")) {
    out.set(ids[n - 1]!, "test");
  }
  return out;
}
