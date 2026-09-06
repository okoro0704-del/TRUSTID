/**
 * Biometric 1:1 / 1:N metrics from labeled pair scores.
 * Similarity = cosine similarity on L2-normalized embeddings (dot product).
 * Production threshold is cosine *distance* = 1 - similarity.
 */

import type {
  DemographicSplitReport,
  FarFrrPoint,
  IdentificationScaleReport,
  LabeledBiometricDataset,
  LabeledSample,
  PairScore,
  TemplateQualityReport,
  ThresholdCalibration,
  VerificationReport,
} from "./types.js";

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

function mean(xs: number[]): number {
  if (!xs.length) return NaN;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return NaN;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx]!;
}

/** Build all unordered genuine pairs + sampled impostor pairs. */
export function buildPairScores(
  dataset: LabeledBiometricDataset,
  options: { maxImpostorPairs?: number; seed?: number } = {},
): PairScore[] {
  const byId = new Map<string, LabeledSample[]>();
  for (const s of dataset.samples) {
    const list = byId.get(s.identityId) ?? [];
    list.push(s);
    byId.set(s.identityId, list);
  }

  const pairs: PairScore[] = [];
  for (const [, samples] of byId) {
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        const a = samples[i]!;
        const b = samples[j]!;
        pairs.push({
          identityA: a.identityId,
          identityB: b.identityId,
          sampleA: a.sampleId,
          sampleB: b.sampleId,
          similarity: cosineSimilarity(a.embedding, b.embedding),
          genuine: true,
        });
      }
    }
  }

  const ids = [...byId.keys()];
  const maxImp = options.maxImpostorPairs ?? Math.max(pairs.length * 10, 10_000);
  let seed = options.seed ?? 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  let impostors = 0;
  let attempts = 0;
  const maxAttempts = maxImp * 20;
  while (impostors < maxImp && attempts < maxAttempts && ids.length >= 2) {
    attempts++;
    const ia = ids[Math.floor(rand() * ids.length)]!;
    const ib = ids[Math.floor(rand() * ids.length)]!;
    if (ia === ib) continue;
    const sa = byId.get(ia)!;
    const sb = byId.get(ib)!;
    const a = sa[Math.floor(rand() * sa.length)]!;
    const b = sb[Math.floor(rand() * sb.length)]!;
    pairs.push({
      identityA: ia,
      identityB: ib,
      sampleA: a.sampleId,
      sampleB: b.sampleId,
      similarity: cosineSimilarity(a.embedding, b.embedding),
      genuine: false,
    });
    impostors++;
  }

  return pairs;
}

function ratesAtThreshold(
  genuine: number[],
  impostor: number[],
  thrSim: number,
): { far: number; frr: number; tar: number } {
  const far =
    impostor.length === 0
      ? NaN
      : impostor.filter((s) => s >= thrSim).length / impostor.length;
  const frr =
    genuine.length === 0
      ? NaN
      : genuine.filter((s) => s < thrSim).length / genuine.length;
  return { far, frr, tar: 1 - frr };
}

/** TAR at target FAR via highest similarity threshold that still meets FAR. */
export function tarAtTargetFar(
  genuine: number[],
  impostor: number[],
  targetFar: number,
): number | null {
  if (!genuine.length || !impostor.length) return null;
  const sortedImp = [...impostor].sort((a, b) => b - a);
  // Threshold: accept if sim >= t. FAR = fraction impostor >= t.
  // Find largest t such that FAR <= targetFar.
  let bestTar: number | null = null;
  const candidates = [...new Set([...genuine, ...impostor])].sort(
    (a, b) => b - a,
  );
  for (const t of candidates) {
    const { far, tar } = ratesAtThreshold(genuine, impostor, t);
    if (far <= targetFar) {
      bestTar = tar;
      break;
    }
  }
  // Also try continuous threshold from impostor order stats
  if (bestTar == null && sortedImp.length) {
    const k = Math.floor(targetFar * sortedImp.length);
    const t = k <= 0 ? sortedImp[0]! + 1e-9 : sortedImp[Math.min(k, sortedImp.length - 1)]!;
    const { far, tar } = ratesAtThreshold(genuine, impostor, t);
    if (far <= targetFar) bestTar = tar;
  }
  return bestTar;
}

export function computeVerificationReport(
  dataset: LabeledBiometricDataset,
  options: {
    operatingThresholdDistance?: number;
    farTargets?: number[];
    maxImpostorPairs?: number;
  } = {},
): VerificationReport {
  const operatingDistance = options.operatingThresholdDistance ?? 0.35;
  const operatingSim = 1 - operatingDistance;
  const farTargets = options.farTargets ?? [
    1e-2, 1e-3, 1e-4, 1e-5, 1e-6,
  ];

  const pairs = buildPairScores(dataset, {
    maxImpostorPairs: options.maxImpostorPairs,
  });
  const genuine = pairs.filter((p) => p.genuine).map((p) => p.similarity);
  const impostor = pairs.filter((p) => !p.genuine).map((p) => p.similarity);

  const status = dataset.syntheticPlumbingOnly
    ? "SYNTHETIC_PLUMBING_ONLY"
    : genuine.length < 2 || impostor.length < 10
      ? "INSUFFICIENT_DATA"
      : "MEASURED";

  const thresholds = [...new Set([...genuine, ...impostor])]
    .sort((a, b) => b - a)
    .slice(0, 500);

  const roc: FarFrrPoint[] = thresholds.map((t) => {
    const r = ratesAtThreshold(genuine, impostor, t);
    return {
      thresholdSimilarity: t,
      far: r.far,
      frr: r.frr,
      tar: r.tar,
    };
  });

  let eer: number | null = null;
  let eerThr: number | null = null;
  let bestDiff = Infinity;
  for (const p of roc) {
    if (!Number.isFinite(p.far) || !Number.isFinite(p.frr)) continue;
    const d = Math.abs(p.far - p.frr);
    if (d < bestDiff) {
      bestDiff = d;
      eer = (p.far + p.frr) / 2;
      eerThr = p.thresholdSimilarity;
    }
  }

  const tarAtFar: Record<string, number | null> = {};
  for (const far of farTargets) {
    tarAtFar[`FAR_${far}`] = tarAtTargetFar(genuine, impostor, far);
  }

  const atOp = ratesAtThreshold(genuine, impostor, operatingSim);

  return {
    kind: "BIOMETRIC_1_1_VERIFICATION",
    datasetName: dataset.name,
    modelName: dataset.modelName,
    modelVersion: dataset.modelVersion,
    genuineCount: genuine.length,
    impostorCount: impostor.length,
    genuineSimilarities: genuine,
    impostorSimilarities: impostor,
    genuineMean: mean(genuine),
    genuineStd: std(genuine),
    impostorMean: mean(impostor),
    impostorStd: std(impostor),
    eer,
    eerThresholdSimilarity: eerThr,
    roc,
    tarAtFar,
    farAtThreshold: Number.isFinite(atOp.far) ? atOp.far : null,
    frrAtThreshold: Number.isFinite(atOp.frr) ? atOp.frr : null,
    operatingThresholdSimilarity: operatingSim,
    status,
  };
}

export function calibrateThreshold(
  verification: VerificationReport,
  currentDistance = 0.35,
): ThresholdCalibration {
  if (
    verification.status === "SYNTHETIC_PLUMBING_ONLY" ||
    verification.status === "INSUFFICIENT_DATA" ||
    verification.eerThresholdSimilarity == null
  ) {
    return {
      currentThresholdCosineDistance: currentDistance,
      currentThresholdSimilarity: 1 - currentDistance,
      proposedThresholdCosineDistance: null,
      proposedThresholdSimilarity: null,
      farCurrent: verification.farAtThreshold,
      frrCurrent: verification.frrAtThreshold,
      farProposed: null,
      frrProposed: null,
      status:
        verification.status === "SYNTHETIC_PLUMBING_ONLY"
          ? "SYNTHETIC_PLUMBING_ONLY"
          : "THRESHOLD_CANNOT_BE_CALIBRATED_WITH_CURRENT_DATA",
      rationale:
        verification.status === "SYNTHETIC_PLUMBING_ONLY"
          ? "Synthetic plumbing vectors cannot calibrate production thresholds."
          : "Need enough labeled genuine and impostor pairs from the production ArcFace pipeline.",
    };
  }

  const proposedSim = verification.eerThresholdSimilarity;
  const proposedDist = 1 - proposedSim;
  const atProp = ratesAtThreshold(
    verification.genuineSimilarities,
    verification.impostorSimilarities,
    proposedSim,
  );

  return {
    currentThresholdCosineDistance: currentDistance,
    currentThresholdSimilarity: 1 - currentDistance,
    proposedThresholdCosineDistance: proposedDist,
    proposedThresholdSimilarity: proposedSim,
    farCurrent: verification.farAtThreshold,
    frrCurrent: verification.frrAtThreshold,
    farProposed: Number.isFinite(atProp.far) ? atProp.far : null,
    frrProposed: Number.isFinite(atProp.frr) ? atProp.frr : null,
    status: "CALIBRATED",
    rationale:
      "Proposed threshold is the measured EER operating point on this labeled dataset only.",
  };
}

/**
 * Closed-set 1:N identification + open-set FPIR/FNIR at a similarity threshold.
 * Gallery must contain distinct identities (one enrolled template each by default).
 */
export function computeIdentificationReport(
  gallery: LabeledSample[],
  genuineProbes: LabeledSample[],
  impostorProbes: LabeledSample[],
  options: {
    thresholdDistance?: number;
    syntheticInfraOnly?: boolean;
  } = {},
): IdentificationScaleReport {
  const thrDist = options.thresholdDistance ?? 0.35;
  const thrSim = 1 - thrDist;
  const latencies: number[] = [];
  let rank1Hits = 0;
  let rank5Hits = 0;
  let rank10Hits = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  const search = (probe: number[]) => {
    const t0 = performance.now();
    const scored = gallery.map((g) => ({
      identityId: g.identityId,
      sim: cosineSimilarity(probe, g.embedding),
    }));
    scored.sort((a, b) => b.sim - a.sim);
    latencies.push(performance.now() - t0);
    return scored;
  };

  for (const probe of genuineProbes) {
    const ranked = search(probe.embedding);
    const mateRank = ranked.findIndex((r) => r.identityId === probe.identityId);
    if (mateRank === 0) rank1Hits++;
    if (mateRank >= 0 && mateRank < 5) rank5Hits++;
    if (mateRank >= 0 && mateRank < 10) rank10Hits++;
    const top = ranked[0];
    if (!top || top.sim < thrSim || top.identityId !== probe.identityId) {
      falseNegatives++;
    }
  }

  for (const probe of impostorProbes) {
    const ranked = search(probe.embedding);
    const top = ranked[0];
    if (top && top.sim >= thrSim) falsePositives++;
  }

  const gN = genuineProbes.length;
  const iN = impostorProbes.length;
  const sorted = [...latencies].sort((a, b) => a - b);
  const totalMs = latencies.reduce((s, x) => s + x, 0);
  const status = options.syntheticInfraOnly
    ? "SYNTHETIC_INFRA_ONLY"
    : gallery.length === 0 || gN === 0
      ? "SKIPPED_INSUFFICIENT_GALLERY"
      : "MEASURED";

  return {
    gallerySize: gallery.length,
    probeCountGenuine: gN,
    probeCountImpostor: iN,
    rank1: gN ? rank1Hits / gN : null,
    rank5: gN ? rank5Hits / gN : null,
    rank10: gN ? rank10Hits / gN : null,
    fpir: iN ? falsePositives / iN : null,
    fnir: gN ? falseNegatives / gN : null,
    latencyMs: {
      p50: sorted.length ? percentile(sorted, 50) : 0,
      p95: sorted.length ? percentile(sorted, 95) : 0,
      p99: sorted.length ? percentile(sorted, 99) : 0,
      mean: latencies.length ? totalMs / latencies.length : 0,
    },
    throughputQps: totalMs > 0 ? (latencies.length * 1000) / totalMs : 0,
    status,
  };
}

export function evaluateTemplateQuality(
  dataset: LabeledBiometricDataset,
  operatingDistance = 0.35,
): TemplateQualityReport {
  const byId = new Map<string, LabeledSample[]>();
  for (const s of dataset.samples) {
    const list = byId.get(s.identityId) ?? [];
    list.push(s);
    byId.set(s.identityId, list);
  }

  const multi = [...byId.values()].filter((xs) => xs.length >= 3);
  if (dataset.syntheticPlumbingOnly) {
    return {
      singleEnrollFar: null,
      singleEnrollFrr: null,
      meanTemplateFar: null,
      meanTemplateFrr: null,
      multiTemplateFar: null,
      multiTemplateFrr: null,
      status: "SYNTHETIC_PLUMBING_ONLY",
      notes: ["Synthetic vectors cannot evaluate enrollment template strategies."],
    };
  }
  if (multi.length < 5) {
    return {
      singleEnrollFar: null,
      singleEnrollFrr: null,
      meanTemplateFar: null,
      meanTemplateFrr: null,
      multiTemplateFar: null,
      multiTemplateFrr: null,
      status: "INSUFFICIENT_DATA",
      notes: [
        "Need ?5 identities with ?3 samples each to compare single vs mean vs multi-template enrollment.",
      ],
    };
  }

  // Build galleries: single (first), mean of first 2, multi (max over first 2)
  const meanVec = (vecs: number[][]) => {
    const dims = vecs[0]!.length;
    const acc = new Array(dims).fill(0);
    for (const v of vecs) {
      for (let i = 0; i < dims; i++) acc[i]! += v[i]!;
    }
    for (let i = 0; i < dims; i++) acc[i]! /= vecs.length;
    let n = 0;
    for (const x of acc) n += x * x;
    n = Math.sqrt(n) || 1;
    return acc.map((x) => x / n);
  };

  const thrSim = 1 - operatingDistance;
  let singleG = 0;
  let singleGFail = 0;
  let meanG = 0;
  let meanGFail = 0;
  let multiG = 0;
  let multiGFail = 0;
  let singleI = 0;
  let singleIFail = 0;
  let meanI = 0;
  let meanIFail = 0;
  let multiI = 0;
  let multiIFail = 0;

  const identities = [...byId.entries()];
  for (const [id, samples] of identities) {
    if (samples.length < 3) continue;
    const enroll = samples.slice(0, 2);
    const probe = samples[2]!;
    const single = enroll[0]!.embedding;
    const averaged = meanVec(enroll.map((s) => s.embedding));
    const galleryMulti = enroll.map((s) => s.embedding);

    const scoreSingle = cosineSimilarity(probe.embedding, single);
    const scoreMean = cosineSimilarity(probe.embedding, averaged);
    const scoreMulti = Math.max(
      ...galleryMulti.map((e) => cosineSimilarity(probe.embedding, e)),
    );

    singleG++;
    if (scoreSingle < thrSim) singleGFail++;
    meanG++;
    if (scoreMean < thrSim) meanGFail++;
    multiG++;
    if (scoreMulti < thrSim) multiGFail++;

    for (const [oid, os] of identities) {
      if (oid === id) continue;
      const impostorProbe = os[0]!;
      singleI++;
      if (cosineSimilarity(impostorProbe.embedding, single) >= thrSim) singleIFail++;
      meanI++;
      if (cosineSimilarity(impostorProbe.embedding, averaged) >= thrSim) meanIFail++;
      multiI++;
      if (
        Math.max(
          ...galleryMulti.map((e) =>
            cosineSimilarity(impostorProbe.embedding, e),
          ),
        ) >= thrSim
      ) {
        multiIFail++;
      }
    }
  }

  return {
    singleEnrollFar: singleI ? singleIFail / singleI : null,
    singleEnrollFrr: singleG ? singleGFail / singleG : null,
    meanTemplateFar: meanI ? meanIFail / meanI : null,
    meanTemplateFrr: meanG ? meanGFail / meanG : null,
    multiTemplateFar: multiI ? multiIFail / multiI : null,
    multiTemplateFrr: multiG ? multiGFail / multiG : null,
    status: "MEASURED",
    notes: [
      "Report-only: production still stores a single primary (gallery length 1) from silent capture.",
      "meanNormalizeEmbeddings helper exists but is not wired into captureSilentFaceFromWebCamera.",
    ],
  };
}

export function evaluateDemographicSplits(
  dataset: LabeledBiometricDataset,
  operatingDistance = 0.35,
): DemographicSplitReport[] {
  const attrKeys = new Set<string>();
  for (const s of dataset.samples) {
    if (!s.demographics) continue;
    for (const k of Object.keys(s.demographics)) {
      if (s.demographics[k]) attrKeys.add(k);
    }
  }
  if (!attrKeys.size) {
    return [
      {
        attribute: "(none)",
        group: "(none)",
        genuineCount: 0,
        impostorCount: 0,
        farAtThreshold: null,
        frrAtThreshold: null,
        tarAtFar1e3: null,
        status: "NO_LABELS",
      },
    ];
  }

  const thrSim = 1 - operatingDistance;
  const reports: DemographicSplitReport[] = [];

  for (const attr of attrKeys) {
    const groups = new Map<string, LabeledSample[]>();
    for (const s of dataset.samples) {
      const g = s.demographics?.[attr];
      if (!g) continue;
      const list = groups.get(g) ?? [];
      list.push(s);
      groups.set(g, list);
    }
    for (const [group, samples] of groups) {
      const subset: LabeledBiometricDataset = {
        ...dataset,
        name: `${dataset.name}:${attr}=${group}`,
        samples,
      };
      const v = computeVerificationReport(subset, {
        operatingThresholdDistance: operatingDistance,
        maxImpostorPairs: 5_000,
      });
      reports.push({
        attribute: attr,
        group,
        genuineCount: v.genuineCount,
        impostorCount: v.impostorCount,
        farAtThreshold: v.farAtThreshold,
        frrAtThreshold: v.frrAtThreshold,
        tarAtFar1e3: v.tarAtFar["FAR_0.001"] ?? null,
        status: v.status === "MEASURED" ? "MEASURED" : "NO_LABELS",
      });
      void thrSim;
    }
  }
  return reports;
}

/** Pick gallery + probes for each target size without duplicating identities. */
export function buildGalleriesWhereDataPermits(
  dataset: LabeledBiometricDataset,
  sizes: number[],
  thresholdDistance = 0.35,
): IdentificationScaleReport[] {
  const byId = new Map<string, LabeledSample[]>();
  for (const s of dataset.samples) {
    const list = byId.get(s.identityId) ?? [];
    list.push(s);
    byId.set(s.identityId, list);
  }
  const multi = [...byId.entries()].filter(([, xs]) => xs.length >= 2);
  const reports: IdentificationScaleReport[] = [];

  for (const size of sizes) {
    if (multi.length < size) {
      reports.push({
        gallerySize: size,
        probeCountGenuine: 0,
        probeCountImpostor: 0,
        rank1: null,
        rank5: null,
        rank10: null,
        fpir: null,
        fnir: null,
        latencyMs: { p50: NaN, p95: NaN, p99: NaN, mean: NaN },
        throughputQps: 0,
        status: "SKIPPED_INSUFFICIENT_GALLERY",
      });
      continue;
    }
    const selected = multi.slice(0, size);
    const gallery = selected.map(([, xs]) => xs[0]!);
    const genuineProbes = selected.map(([, xs]) => xs[1]!);
    const leftover = multi.slice(size).map(([, xs]) => xs[0]!);
    const impostorProbes = leftover.slice(0, Math.min(leftover.length, size));
    reports.push(
      computeIdentificationReport(gallery, genuineProbes, impostorProbes, {
        thresholdDistance,
        syntheticInfraOnly: dataset.syntheticPlumbingOnly,
      }),
    );
  }
  return reports;
}
