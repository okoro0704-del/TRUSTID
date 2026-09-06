/**
 * Labeled biometric evaluation types.
 * Accuracy claims require real face embeddings from the production pipeline 
 * never synthetic random vectors.
 */

export type DemographicLabels = {
  /** Only use labels present in the dataset; never infer from faces. */
  sex?: string;
  ageGroup?: string;
  ethnicity?: string;
  [key: string]: string | undefined;
};

export type FailureModeTag =
  | "poor_lighting"
  | "blur"
  | "side_pose"
  | "extreme_pose"
  | "glasses"
  | "facial_hair"
  | "partial_occlusion"
  | "small_face"
  | "low_resolution"
  | "multiple_faces"
  | "different_device"
  | string;

/** One capture / template sample for an identity. */
export type LabeledSample = {
  sampleId: string;
  identityId: string;
  /** L2-normalized 512-D ArcFace embedding from production pipeline. */
  embedding: number[];
  demographics?: DemographicLabels;
  failureModes?: FailureModeTag[];
  qualityScore?: number;
  /** Optional split label: train | development | validation | test */
  split?: string;
  sessionId?: string;
  imagePath?: string;
};

export type LabeledBiometricDataset = {
  name: string;
  /** Must match production recognizer when claiming TrustID accuracy. */
  modelName: string;
  modelVersion: number;
  embeddingDims: number;
  samples: LabeledSample[];
  /**
   * When true, results are plumbing/math checks only  NOT biometric accuracy.
   */
  syntheticPlumbingOnly?: boolean;
};

export type PairScore = {
  identityA: string;
  identityB: string;
  sampleA: string;
  sampleB: string;
  /** Cosine similarity in [-1, 1] for L2 unit vectors. */
  similarity: number;
  genuine: boolean;
};

export type FarFrrPoint = {
  /** Cosine similarity threshold: accept if similarity >= this */
  thresholdSimilarity: number;
  /** Cosine distance threshold: accept if distance <= this (= 1 - similarity) */
  thresholdDistance: number;
  far: number;
  frr: number;
  tar: number;
  trr: number;
  tp: number;
  tn: number;
  fp: number;
  fn: number;
};

export type OperatingPointReport = {
  targetFar: number;
  estimability:
    | "ESTIMABLE"
    | "NOT_ESTIMABLE_WITH_CURRENT_SAMPLE_SIZE";
  estimabilityReason?: string;
  actualFar: number | null;
  thresholdSimilarity: number | null;
  thresholdDistance: number | null;
  tar: number | null;
  frr: number | null;
  trr: number | null;
  genuineTrials: number;
  impostorTrials: number;
  farCi95?: { low: number; high: number } | null;
  tarCi95?: { low: number; high: number } | null;
};

export type VerificationReport = {
  kind: "BIOMETRIC_1_1_VERIFICATION";
  datasetName: string;
  modelName: string;
  modelVersion: number;
  subjectCount: number;
  imageCount: number;
  genuineCount: number;
  impostorCount: number;
  /** Cosine similarities (higher = more similar). Distance = 1 - similarity. */
  genuineSimilarities: number[];
  impostorSimilarities: number[];
  genuineDistances: number[];
  impostorDistances: number[];
  genuineMean: number;
  genuineStd: number;
  impostorMean: number;
  impostorStd: number;
  genuineDistanceMean: number;
  impostorDistanceMean: number;
  eer: number | null;
  eerThresholdSimilarity: number | null;
  eerThresholdDistance: number | null;
  roc: FarFrrPoint[];
  operatingPoints: OperatingPointReport[];
  tarAtFar: Record<string, number | null>;
  farAtThreshold: number | null;
  frrAtThreshold: number | null;
  tarAtThreshold: number | null;
  trrAtThreshold: number | null;
  operatingThresholdSimilarity: number;
  operatingThresholdDistance: number;
  split?: string;
  status: "MEASURED" | "INSUFFICIENT_DATA" | "SYNTHETIC_PLUMBING_ONLY";
};

export type IdentificationScaleReport = {
  gallerySize: number;
  probeCountGenuine: number;
  probeCountImpostor: number;
  rank1: number | null;
  rank5: number | null;
  rank10: number | null;
  fpir: number | null;
  fnir: number | null;
  latencyMs: { p50: number; p95: number; p99: number; mean: number };
  throughputQps: number;
  status: "MEASURED" | "SKIPPED_INSUFFICIENT_GALLERY" | "SYNTHETIC_INFRA_ONLY";
};

export type TemplateQualityReport = {
  singleEnrollFar: number | null;
  singleEnrollFrr: number | null;
  meanTemplateFar: number | null;
  meanTemplateFrr: number | null;
  multiTemplateFar: number | null;
  multiTemplateFrr: number | null;
  status: "MEASURED" | "INSUFFICIENT_DATA" | "SYNTHETIC_PLUMBING_ONLY";
  notes: string[];
};

export type DemographicSplitReport = {
  attribute: string;
  group: string;
  genuineCount: number;
  impostorCount: number;
  farAtThreshold: number | null;
  frrAtThreshold: number | null;
  tarAtFar1e3: number | null;
  status: "MEASURED" | "NO_LABELS";
};

export type ThresholdCalibration = {
  currentThresholdCosineDistance: number;
  currentThresholdSimilarity: number;
  proposedThresholdCosineDistance: number | null;
  proposedThresholdSimilarity: number | null;
  farCurrent: number | null;
  frrCurrent: number | null;
  farProposed: number | null;
  frrProposed: number | null;
  status:
    | "CALIBRATED"
    | "THRESHOLD_CANNOT_BE_CALIBRATED_WITH_CURRENT_DATA"
    | "SYNTHETIC_PLUMBING_ONLY";
  rationale: string;
};
