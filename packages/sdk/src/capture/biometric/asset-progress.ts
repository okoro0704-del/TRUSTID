/**
 * Download progress for biometric assets. Byte counts and URLs only.
 */
export type BiometricAssetId = "ort-wasm" | "mediapipe-wasm" | "face-landmarker" | "arcface";

export type BiometricAssetProgress = {
  url: string;
  loaded: number;
  total: number | null;
  fromCache: boolean;
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
