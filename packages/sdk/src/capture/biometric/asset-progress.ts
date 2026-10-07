/**
 * Download progress for biometric assets. Byte counts and URLs only.
 */
export type BiometricAssetId =
  | "ort-wasm"
  | "ort-loader"
  | "mediapipe-wasm"
  | "mediapipe-loader"
  | "face-landmarker"
  | "arcface";

/** Where an asset's bytes came from. */
export type BiometricAssetSource = "app-bundle" | "cache" | "network";

/** downloading -> decoding -> verifying -> ready. Local sources skip downloading. */
export type BiometricAssetPhase = "downloading" | "decoding" | "verifying" | "ready";

export type BiometricAssetProgress = {
  url: string;
  /** Bytes received over the network so far (compressed when the transfer is). */
  loaded: number;
  /** Bytes the transfer will carry, or null while unknown. */
  total: number | null;
  /** True for any local source (Cache Storage or the installed app). */
  fromCache: boolean;
  source?: BiometricAssetSource;
  phase?: BiometricAssetPhase;
};

const progress = new Map<BiometricAssetId, BiometricAssetProgress>();
const listeners = new Set<() => void>();

export function reportAssetProgress(
  id: BiometricAssetId,
  update: BiometricAssetProgress,
): void {
  progress.set(id, update);
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a listener must not break a download */
    }
  }
}

export function getAssetProgress(id: BiometricAssetId): BiometricAssetProgress | null {
  return progress.get(id) ?? null;
}

export function onAssetProgress(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function resetAssetProgressForTests(): void {
  progress.clear();
  listeners.clear();
}
