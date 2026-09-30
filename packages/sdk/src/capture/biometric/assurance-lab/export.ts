import type { LabStudyReport } from "./analysis.js";

const FORBIDDEN_EXPORT_KEYS = new Set(
  [
    "embedding",
    "embeddings",
    "vector",
    "vectors",
    "image",
    "imageBase64",
    "imagePath",
    "rawImage",
    "frame",
    "token",
    "sessionToken",
    "accessToken",
    "privateKey",
    "secret",
    "trustId",
    "userId",
    "email",
    "phone",
    "participantId",
    "captureId",
    "sessionId",
    "genuineSimilarities",
    "impostorSimilarities",
    "genuineDistances",
    "impostorDistances",
  ].map((k) => k.toLowerCase()),
);

/** Reject anything that could re-identify a participant or leak a credential. */
export function assertExportPrivacy(value: unknown, path = "$"): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    if (value.length >= 64 && value.every((v) => typeof v === "number")) {
      throw new Error(`Export contains a long numeric array at ${path} (possible vector)`);
    }
    value.forEach((v, i) => assertExportPrivacy(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "string") {
    if (/^data:image\//i.test(value) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
      throw new Error(`Export contains image or key material at ${path}`);
    }
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_EXPORT_KEYS.has(key.toLowerCase())) {
      throw new Error(`Export must not contain ${path}.${key}`);
    }
    assertExportPrivacy(child, `${path}.${key}`);
  }
}

/** JSON with sorted keys so identical evidence produces identical bytes. */
export function stableStringify(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    if (typeof v === "number" && !Number.isFinite(v)) return null;
    return v;
  };
  return JSON.stringify(norm(value), null, 2);
}

export type AssuranceEvidenceExport = {
  schema: "trustid_assurance_lab_export_v1";
  generatedFrom: "AGGREGATE_ONLY";
  excludedForDeterminism: string[];
  report: Omit<LabStudyReport, "generatedAt" | "identification"> & {
    identification: Omit<LabStudyReport["identification"], "closedSet" | "openSet"> & {
      closedSet: Omit<LabStudyReport["identification"]["closedSet"], "metrics"> & {
        metrics: Omit<LabStudyReport["identification"]["closedSet"]["metrics"], "latencyMs">;
      };
      openSet: Omit<LabStudyReport["identification"]["openSet"], "metrics"> & {
        metrics: Omit<LabStudyReport["identification"]["openSet"]["metrics"], "latencyMs">;
      };
    };
  };
};

function withoutLatency<T extends { latencyMs: unknown }>(metrics: T): Omit<T, "latencyMs"> {
  const { latencyMs: _latencyMs, ...rest } = metrics;
  void _latencyMs;
  return rest;
}

/**
 * Aggregate, deterministic export. The report already excludes vectors and
 * per-pair scores; this re-checks and omits wall-clock values (timestamp and
 * measured 1:N latency) so the same evidence always exports identically.
 */
export function buildAssuranceExport(report: LabStudyReport): { json: string; export: AssuranceEvidenceExport } {
  const { generatedAt: _generatedAt, identification, ...rest } = report;
  void _generatedAt;
  const out: AssuranceEvidenceExport = {
    schema: "trustid_assurance_lab_export_v1",
    generatedFrom: "AGGREGATE_ONLY",
    excludedForDeterminism: ["generatedAt", "identification.*.metrics.latencyMs"],
    report: {
      ...rest,
      identification: {
        ...identification,
        closedSet: { ...identification.closedSet, metrics: withoutLatency(identification.closedSet.metrics) },
        openSet: { ...identification.openSet, metrics: withoutLatency(identification.openSet.metrics) },
      },
    },
  };
  assertExportPrivacy(out);
  return { json: stableStringify(out), export: out };
}
