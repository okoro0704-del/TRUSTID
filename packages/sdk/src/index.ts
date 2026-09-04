import {
  BIOMETRIC_MODALITIES,
  TRUST_ID_ACCESS_LEVELS,
  type BiometricModality,
  type TrustIdAccessLevel,
} from "@trustid/shared";
import { ambientAuthenticate } from "./ambient.js";
import type { AmbientAuthenticateOptions, AmbientSignInResult, FaceLookupResult } from "./ambient.js";
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

  /**
   * Launch-time face lookup — never creates an account.
   * Uses ultra-fast edge-vector cascade (~2KB payload, hot cache → HNSW).
   * NOT_FOUND requires explicit user consent before ambient enroll.
   */
  async faceLookup(input: {
    face: MultiModalBiometricPayload["face"];
    installId?: string;
    deviceFingerprint?: string;
    /** Locally cached Trust ID — enables Path A 1:1 verification */
    cachedTrustId?: string;
    deviceId?: string;
  }): Promise<import("./ambient.js").FaceLookupResult> {
    const vector = input.face?.vector;
    if (vector?.length === 512) {
      return this.api("/v1/auth/fast-vector-match", {
        method: "POST",
        body: JSON.stringify({
          vector,
          faceVector: vector,
          confidence: input.face?.confidence,
          modelName: input.face?.modelName,
          modelVersion: input.face?.modelVersion,
          installId: input.installId,
          deviceFingerprint:
            input.deviceFingerprint ?? input.face?.deviceFingerprint,
          deviceId: input.deviceId,
          cachedTrustId: input.cachedTrustId,
        }),
      });
    }
    return this.api("/v1/identity/face-lookup", {
      method: "POST",
      body: JSON.stringify({
        face: input.face,
        installId: input.installId,
        deviceFingerprint: input.deviceFingerprint,
      }),
    });
  }

  /** Explicit ultra-fast 512-D vector match (edge extraction only). */
  async fastVectorMatch(input: {
    vector: number[];
    installId?: string;
    deviceId?: string;
    deviceFingerprint?: string;
    cachedTrustId?: string;
    confidence?: number;
  }): Promise<
    import("./ambient.js").FaceLookupResult & {
      durationMs?: number;
      strategy?: string;
      distance?: number;
    }
  > {
    return this.api("/v1/auth/fast-vector-match", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Dual-path biometric login alias. */
  async biometricLogin(input: {
    faceVector: number[];
    deviceId?: string;
    cachedTrustId?: string;
    installId?: string;
    deviceFingerprint?: string;
  }): Promise<
    import("./ambient.js").FaceLookupResult & {
      durationMs?: number;
      strategy?: string;
      distance?: number;
    }
  > {
    return this.api("/v1/auth/biometric-login", {
      method: "POST",
      body: JSON.stringify({
        faceVector: input.faceVector,
        vector: input.faceVector,
        deviceId: input.deviceId,
        cachedTrustId: input.cachedTrustId,
        installId: input.installId,
        deviceFingerprint: input.deviceFingerprint,
      }),
    });
  }

  /**
   * Create Trust ID after consent — binds this terminal as Master Device.
   */
  async registerTrustId(input: MultiModalBiometricPayload & {
    installId?: string;
    deviceName?: string;
    deviceFingerprint?: string;
    pushToken?: string;
    pushPlatform?: "android" | "ios" | "web";
  }): Promise<AmbientSignInResult & {
    success?: boolean;
    user?: { id: string; trustId: string };
    device?: { id: string; isMasterDevice: boolean; masterDeviceId?: string };
    token?: string;
  }> {
    const data = await this.api<{
      success?: boolean;
      matched?: boolean;
      enrolled?: boolean;
      trustId?: string;
      identity?: unknown;
      sessionToken?: string;
      token?: string;
      isMasterDevice?: boolean;
      user?: { id: string; trustId: string };
      device?: { id: string; isMasterDevice: boolean; masterDeviceId?: string };
    }>("/v1/identity/register-trust-id", {
      method: "POST",
      body: JSON.stringify({
        ...input,
        deviceFingerprint:
          input.deviceFingerprint ?? input.face?.deviceFingerprint,
      }),
    });
    return {
      matched: data.matched ?? true,
      enrolled: data.enrolled ?? true,
      trustId: data.trustId ?? data.user?.trustId,
      identity: data.identity,
      sessionToken: data.sessionToken ?? data.token,
      isMasterDevice: data.isMasterDevice ?? true,
      success: data.success,
      user: data.user,
      device: data.device,
      token: data.token ?? data.sessionToken,
    };
  }

  /** Explicit Master Device bind + optional FCM token refresh. */
  async bindMasterDevice(input: {
    deviceFingerprint: string;
    deviceId?: string;
    deviceName?: string;
    pushToken?: string;
    pushPlatform?: "android" | "ios" | "web";
  }) {
    return this.api<{
      success: boolean;
      deviceId: string | null;
      masterDeviceId: string;
      isMasterDevice: boolean;
    }>("/v1/device/register-master", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /**
   * Bound-install unlock after native fingerprint / device PIN succeeds.
   */
  async installUnlock(input: {
    installId: string;
    localAuthOk?: boolean;
  }): Promise<AmbientSignInResult & { authenticatedVia?: string; token?: string }> {
    const data = await this.api<{
      status?: string;
      authenticatedVia?: string;
      trustId?: string;
      identity?: unknown;
      sessionToken?: string;
      token?: string;
      isMasterDevice?: boolean;
    }>("/v1/auth/install-unlock", {
      method: "POST",
      body: JSON.stringify({
        installId: input.installId,
        localAuthOk: input.localAuthOk ?? true,
      }),
    });
    return {
      matched: true,
      trustId: data.trustId,
      identity: data.identity,
      sessionToken: data.sessionToken ?? data.token,
      isMasterDevice: data.isMasterDevice ?? true,
      authenticatedVia: data.authenticatedVia,
      token: data.token ?? data.sessionToken,
    };
  }

  async registerPushToken(input: {
    token: string;
    platform?: "android" | "ios" | "web";
    deviceId?: string;
    channelId?: string;
  }) {
    return this.api<{
      ok: boolean;
      id?: string;
      platform?: string;
      via?: string;
    }>("/v1/devices/push-token", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Short-lived JWT for direct ElfCom POST /v1/devices/register */
  async mintElfComCapabilityToken() {
    return this.api<{
      ok: boolean;
      token: string;
      trustId: string;
      expiresInSeconds: number;
      elfcomBaseUrl: string;
      appId: string;
    }>("/v1/elfcom/capability-token", {
      method: "POST",
      body: "{}",
    });
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
  FaceLookupResult,
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
