import type { TrustIdAccessLevel } from "@trustid/shared";
import { captureSingleBiometric } from "./capture/single-modal.js";
import type { CaptureHandlers, MultiModalBiometricPayload } from "./capture/types.js";

export type AmbientAuthenticateOptions = CaptureHandlers & {
  allowAutoEnroll?: boolean;
  installId?: string;
  payload?: MultiModalBiometricPayload;
};

export type AmbientSignInResult = {
  matched: boolean;
  enrolled?: boolean;
  trustId?: string;
  accessLevel?: TrustIdAccessLevel;
  isMasterDevice?: boolean;
  matchedModality?: "face" | "fingerprint" | "both";
  fusionScore?: number;
  faceMatchScore?: number;
  fingerprintMatchScore?: number;
  identity?: unknown;
  sessionToken?: string;
  /** Cloud identity matched but this terminal needs Master Device approval */
  needsMasterApproval?: boolean;
  approvalPollToken?: string;
  approvalRequestId?: string;
  /** Offer saving a silent device key after approval (not a second passkey) */
  offerSaveDeviceKey?: boolean;
  error?: string;
};

type AmbientSdkLike = {
  ambientSignIn(
    payload: MultiModalBiometricPayload & {
      allowAutoEnroll?: boolean;
      installId?: string;
    },
  ): Promise<AmbientSignInResult>;
};

export async function ambientAuthenticate(
  sdk: AmbientSdkLike,
  options: AmbientAuthenticateOptions = {},
): Promise<AmbientSignInResult> {
  const payload =
    options.payload ??
    (await captureSingleBiometric({
      captureFace: options.captureFace,
      captureFingerprint: options.captureFingerprint,
      getDeviceFingerprint: options.getDeviceFingerprint,
    }));

  if (!payload.face?.vector && !payload.face?.embedding) {
    return {
      matched: false,
      error:
        "No face detected. Look straight at the camera so Trust ID can verify you.",
    };
  }

  const faceConfidence = payload.face.confidence;
  if (faceConfidence != null && faceConfidence < 0.5) {
    return {
      matched: false,
      error:
        "Face signal too weak. Hold still and look at the camera.",
    };
  }

  try {
    return await sdk.ambientSignIn({
      ...payload,
      allowAutoEnroll: options.allowAutoEnroll ?? true,
      installId: options.installId,
    });
  } catch (err) {
    return {
      matched: false,
      error: err instanceof Error ? err.message : "Ambient sign-in failed",
    };
  }
}
