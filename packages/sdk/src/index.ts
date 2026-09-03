import {
  BIOMETRIC_MODALITIES,
  TRUST_ID_ACCESS_LEVELS,
  type BiometricModality,
  type TrustIdAccessLevel,
} from "@trustid/shared";
import { ambientAuthenticate } from "./ambient.js";
import type { AmbientAuthenticateOptions, AmbientSignInResult } from "./ambient.js";
import { captureSingleBiometric } from "./capture/single-modal.js";
import { captureMultiModal } from "./capture/multi-modal.js";
import { detectDeviceBiometricContext } from "./capture/device-context.js";
import { embeddingFromBytes } from "./capture/embedding.js";
import { captureWebFaceProxy, captureWebFingerprint } from "./capture/web.js";
import {
  createSilentCameraCapturer,
  SilentCameraCapturer,
  supportsSilentFaceCapture,
} from "./capture/silent-camera-capturer.js";
import {
  captureSilentFaceFromWebCamera,
  isSilentWebCameraAvailable,
} from "./capture/silent-camera-web.js";
import { captureSilentFaceFromNative } from "./capture/silent-camera-native.js";
import { promptFingerprintFallback } from "./capture/fingerprint-fallback.js";
import {
  captureNativeFingerprintTemplate,
  fingerprintPayloadFromPublicKey,
  fingerprintVectorFromPublicKey,
} from "./capture/fingerprint-template.js";
import {
  AIVectorExtractor,
  aiVectorExtractor,
  projectTo512,
} from "./capture/ai-vector-extractor.js";
import { detectFacePresence } from "./capture/face-presence.js";
import { vectorizeFaceFromRgba } from "./capture/face-vectorizer.js";
import type { CaptureHandlers, MultiModalBiometricPayload } from "./capture/types.js";

export type BiometricPayload = {
  modality: BiometricModality;
  /** Legacy variable-length embedding */
  embedding?: number[];
  /** On-device AI 512-D normalized vector (preferred) */
  vector?: number[];
  modelName?: string;
  modelVersion?: number;
  deviceFingerprint?: string;
  /** Local face-presence / capture quality 0–1 */
  confidence?: number;
};

export type ScanAndIdentifyResult = {
  matched: boolean;
  trustId?: string;
  accessLevel?: TrustIdAccessLevel;
  isMasterDevice?: boolean;
  similarity?: number;
  identity?: unknown;
  sessionToken?: string;
  error?: string;
  masterRequired?: boolean;
};

export type AmbientSignInApiResult = AmbientSignInResult;

export type VerifyMasterDeviceResult = {
  verified: boolean;
  masterDeviceId?: string;
  challengeId?: string;
  accessLevel?: TrustIdAccessLevel;
};

export type TrustIdSdkOptions = {
  baseUrl?: string;
  credentials?: RequestCredentials;
  fetchImpl?: typeof fetch;
};

/**
 * Identity-first Trust ID client SDK.
 * Devices are passive capture terminals ? identity lives in the cloud registry.
 */
export class TrustIdSdk {
  private readonly baseUrl: string;
  private readonly credentials: RequestCredentials;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TrustIdSdkOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.credentials = options.credentials ?? "include";
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      credentials: this.credentials,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const data = (await res.json().catch(() => ({}))) as T & {
      error?: string;
      message?: string;
    };
    if (!res.ok) {
      throw new Error(
        (data as { message?: string }).message ??
          (data as { error?: string }).error ??
          `HTTP ${res.status}`,
      );
    }
    return data;
  }

  /**
 * Zero-UI ambient authenticate ? auto-invoked on app boot.
 * Captures one context-aware biometric, resolves server-side, issues session.
   */
  async ambientAuthenticate(
    options: AmbientAuthenticateOptions = {},
  ): Promise<AmbientSignInResult> {
    return ambientAuthenticate(this, options);
  }

  /** Multi-modal ambient sign-in (called by ambientAuthenticate). */
  async ambientSignIn(
    payload: MultiModalBiometricPayload & {
      allowAutoEnroll?: boolean;
      installId?: string;
    },
  ): Promise<AmbientSignInResult> {
    const data = await this.api<{
      matched: boolean;
      enrolled?: boolean;
      trustId?: string;
      accessLevel?: TrustIdAccessLevel;
      isMasterDevice?: boolean;
      fusionScore?: number;
      faceMatchScore?: number;
      fingerprintMatchScore?: number;
      matchedModality?: "face" | "fingerprint" | "both";
      isFaceMatched?: boolean;
      isFingerprintMatched?: boolean;
      identity?: unknown;
      sessionToken?: string;
      needsMasterApproval?: boolean;
      approvalPollToken?: string;
      approvalRequestId?: string;
      offerSaveDeviceKey?: boolean;
    }>("/v1/trust-id/ambient-signin", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return {
      matched: data.matched,
      enrolled: data.enrolled,
      trustId: data.trustId,
      accessLevel: data.accessLevel,
      isMasterDevice: data.isMasterDevice,
      fusionScore: data.fusionScore,
      faceMatchScore: data.faceMatchScore,
      fingerprintMatchScore: data.fingerprintMatchScore,
      matchedModality: data.matchedModality,
      identity: data.identity,
      sessionToken: data.sessionToken,
      needsMasterApproval: data.needsMasterApproval,
      approvalPollToken: data.approvalPollToken,
      approvalRequestId: data.approvalRequestId,
      offerSaveDeviceKey: data.offerSaveDeviceKey,
    };
  }

  async pollDeviceApproval(pollToken: string): Promise<{
    requestId: string;
    status: string;
    message?: string;
    expiresAt?: string;
  }> {
    return this.api(`/device-approvals/poll/${encodeURIComponent(pollToken)}`);
  }

  async claimDeviceApproval(pollToken: string): Promise<{
    mode: string;
    status: string;
    identity?: unknown;
    sessionToken?: string;
    sessionId?: string;
    offerSaveDeviceKey?: boolean;
    enrollmentToken?: string;
  }> {
    return this.api("/device-approvals/claim", {
      method: "POST",
      body: JSON.stringify({ pollToken }),
    });
  }

  async scanAndIdentify(
    biometricPayload: BiometricPayload,
    options?: { requireMasterAccess?: boolean },
  ): Promise<ScanAndIdentifyResult> {
    try {
      const data = await this.api<{
        matched: boolean;
        trustId?: string;
        accessLevel?: TrustIdAccessLevel;
        isMasterDevice?: boolean;
        similarity?: number;
        identity?: unknown;
        sessionToken?: string;
        error?: string;
      }>("/v1/trust-id/verify-biometric", {
        method: "POST",
        body: JSON.stringify({
          biometric: biometricPayload,
          requireMasterAccess: options?.requireMasterAccess ?? false,
        }),
      });
      return {
        matched: data.matched,
        trustId: data.trustId,
        accessLevel: data.accessLevel,
        isMasterDevice: data.isMasterDevice,
        similarity: data.similarity,
        identity: data.identity,
        sessionToken: data.sessionToken,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Biometric identify failed";
      const masterRequired = /master device/i.test(msg);
      return {
        matched: masterRequired,
        masterRequired,
        error: msg,
        accessLevel: masterRequired
          ? TRUST_ID_ACCESS_LEVELS.UNIVERSAL
          : undefined,
      };
    }
  }

  async enrollBiometric(biometricPayload: BiometricPayload) {
    return this.api<{ templateId: string; modality: string }>(
      "/v1/trust-id/enroll-biometric",
      {
        method: "POST",
        body: JSON.stringify({ biometric: biometricPayload }),
      },
    );
  }

  async registerMasterDevice(input: {
    deviceFingerprint: string;
    publicKey: string;
    deviceId?: string;
  }) {
    return this.api<{ masterDeviceId: string; isMasterDevice: boolean }>(
      "/v1/trust-id/master-device/register",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  async verifyMasterDevice(input: {
    deviceFingerprint: string;
    challengeId: string;
    signature: string;
  }): Promise<VerifyMasterDeviceResult> {
    const data = await this.api<{
      verified: boolean;
      masterDeviceId: string;
      accessLevel?: TrustIdAccessLevel;
    }>("/v1/trust-id/master-device/verify", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return {
      verified: data.verified,
      masterDeviceId: data.masterDeviceId,
      challengeId: input.challengeId,
      accessLevel: data.accessLevel ?? TRUST_ID_ACCESS_LEVELS.MASTER,
    };
  }

  async issueMasterChallenge(input: {
    userId: string;
    action: string;
    payload?: Record<string, unknown>;
    requesterFingerprint?: string;
  }) {
    return this.api<{
      challengeId: string;
      action: string;
      expiresAt: string;
      status: string;
    }>("/v1/trust-id/challenges/issue", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async approveMasterChallenge(input: {
    challengeId: string;
    deviceFingerprint: string;
    signature: string;
  }) {
    return this.api<{
      challengeId: string;
      status: string;
      accessLevel: TrustIdAccessLevel;
    }>("/v1/trust-id/challenges/approve", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /**
   * Silent fingerprint fallback when background face capture fails or is low confidence.
   */
  async promptFingerprintFallback(
    handlers: Parameters<typeof promptFingerprintFallback>[0] = {},
  ) {
    return promptFingerprintFallback(handlers);
  }

  /** Zero-UI silent background face capturer for Android/PWA ambient sign-in. */
  createSilentCameraCapturer(
    options: ConstructorParameters<typeof SilentCameraCapturer>[0] = {},
  ) {
    return createSilentCameraCapturer(options);
  }
}

export function createTrustIdSdk(options?: TrustIdSdkOptions) {
  return new TrustIdSdk(options);
}

export {
  BIOMETRIC_MODALITIES,
  TRUST_ID_ACCESS_LEVELS,
  ambientAuthenticate,
  captureMultiModal,
  captureSingleBiometric,
  createSilentCameraCapturer,
  detectDeviceBiometricContext,
  embeddingFromBytes,
  captureWebFaceProxy,
  captureWebFingerprint,
  captureSilentFaceFromWebCamera,
  isSilentWebCameraAvailable,
  captureSilentFaceFromNative,
  promptFingerprintFallback,
  captureNativeFingerprintTemplate,
  fingerprintPayloadFromPublicKey,
  fingerprintVectorFromPublicKey,
  supportsSilentFaceCapture,
  vectorizeFaceFromRgba,
  SilentCameraCapturer,
  AIVectorExtractor,
  aiVectorExtractor,
  projectTo512,
  detectFacePresence,
};
export type {
  AmbientAuthenticateOptions,
  AmbientSignInResult,
} from "./ambient.js";
export type { CaptureHandlers, MultiModalBiometricPayload } from "./capture/types.js";
export type { DeviceBiometricContext, DevicePlatform } from "./capture/device-context.js";
export type {
  SilentCameraCapturerOptions,
  SilentFaceCaptureOutcome,
} from "./capture/silent-camera-capturer.js";
export type { SilentFaceCaptureBridge } from "./capture/silent-camera-native.js";
export type { FingerprintFallbackHandlers } from "./capture/fingerprint-fallback.js";
export type { FingerprintTemplateBridge } from "./capture/fingerprint-template.js";
export type { FaceVectorResult } from "./capture/face-vectorizer.js";
export type { AIVectorPayload, AIVectorExtractorOptions } from "./capture/ai-vector-extractor.js";
export type { FacePresenceResult } from "./capture/face-presence.js";
