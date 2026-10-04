/**
 * Ambient auth state machine: NO_MATCH terminates scan; service errors ? no-match.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, type ReactNode } from "react";
import { TrustIdAuthProvider } from "../src/context/TrustIdAuthProvider.js";
import {
  BIOMETRIC_UNAVAILABLE_ERROR,
  useAmbientTrustIdAuth,
} from "../src/hooks/useAmbientTrustIdAuth.js";
import type { TrustIdApiClient } from "../src/api/client.js";
import { resetEnrollmentCandidateForDev } from "../src/hooks/enrollmentCandidateSession.js";
import { TrustIdAmbientAuthProvider } from "../src/components/TrustIdAmbientAuthProvider.js";

const faceLookup = vi.fn();
const registerTrustId = vi.fn();
const ambientSignIn = vi.fn();
const enrollBiometric = vi.fn();

vi.mock("@trustid/sdk", async (importOriginal) => ({
  ...await importOriginal<typeof import("@trustid/sdk")>(),
  createTrustIdSdk: () => ({
    faceLookup,
    registerTrustId,
    ambientSignIn,
    enrollBiometric,
    bindMasterDevice: vi.fn(async () => ({ success: true })),
    pollDeviceApproval: vi.fn(),
    claimDeviceApproval: vi.fn(),
  }),
}));

function sessionApi(): TrustIdApiClient {
  return {
    getBaseUrl: () => "/api",
    fetch: vi.fn(async (path: string) => {
      if (path === "/auth/session") {
        throw new Error("unauthorized");
      }
      throw new Error(`unexpected ${path}`);
    }),
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <TrustIdAuthProvider apiClient={sessionApi()} enableRealtime={false}>
      {children}
    </TrustIdAuthProvider>
  );
}

function facePayload(overrides: Record<string, unknown> = {}) {
  return {
    face: {
      modality: "face" as const,
      vector: Array.from({ length: 512 }, (_, i) => i / 512),
      modelName: "insightface_arcface_w600k_mbf_v1",
      modelVersion: 1,
      confidence: 0.9,
      ...overrides,
    },
  };
}

describe("useAmbientTrustIdAuth state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEnrollmentCandidateForDev();
    faceLookup.mockResolvedValue({ status: "NOT_FOUND", canRegister: true });
    registerTrustId.mockResolvedValue({
      matched: true,
      enrolled: true,
      trustId: "TD-NEW0001",
      identity: {
        trustId: "TD-NEW0001",
        status: "active",
        profile: { name: "New" },
        contacts: [],
      },
      sessionToken: "tok",
      device: { id: "dev1", isMasterDevice: true },
    });
  });

  it("NO_MATCH stops scanning and does not auto-register", async () => {
    const capturePayload = vi.fn(async () => facePayload());
    const { result } = renderHook(
      () =>
        useAmbientTrustIdAuth({
          enabled: true,
          allowAutoEnroll: false,
          capturePayload,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.phase).toBe("NO_MATCH"), {
      timeout: 5000,
    });
    expect(registerTrustId).not.toHaveBeenCalled();
    expect(faceLookup).toHaveBeenCalledTimes(1);

    // Should not keep re-scanning while on NO_MATCH
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(faceLookup).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("NO_MATCH");
  });

  it("shows registration after no-match, stops the camera, and waits for consent", async () => {
    const capturePayload = vi.fn(async () => facePayload());
    const view = render(
      <TrustIdAmbientAuthProvider capturePayload={capturePayload}>
        Signed in
      </TrustIdAmbientAuthProvider>, { wrapper },
    );
    const register = await screen.findByRole(
      "button",
      { name: "Create TrustID" },
      { timeout: 8000 },
    );
    expect(view.container.querySelector(".tid-silent-splash-ring")).toBeNull();
    expect((faceLookup.mock.calls[0][0].signal as AbortSignal).aborted).toBe(true);
    expect(registerTrustId).not.toHaveBeenCalled();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); });
    expect(capturePayload).toHaveBeenCalledTimes(1);
    fireEvent.click(register);
    await screen.findByText("Signed in");
    expect(registerTrustId).toHaveBeenCalledTimes(1);
    expect(capturePayload).toHaveBeenCalledTimes(1);
    view.unmount();
  }, 15000);

  it("RETRY starts a fresh scan after NO_MATCH", async () => {
    const capturePayload = vi.fn(async () => facePayload());
    const { result } = renderHook(
      () =>
        useAmbientTrustIdAuth({
          enabled: true,
          allowAutoEnroll: false,
          capturePayload,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.phase).toBe("NO_MATCH"));
    const callsBefore = faceLookup.mock.calls.length;

    act(() => {
      result.current.retry();
    });

    await waitFor(() =>
      expect(faceLookup.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("ends a hanging lookup as a service error, never as 'no TrustID'", async () => {
    vi.useFakeTimers();
    let resolveLookup!: (value: unknown) => void;
    faceLookup.mockImplementation(() => new Promise(resolve => { resolveLookup = resolve; }));
    const capturePayload = vi.fn(async () => facePayload());
    const { result, unmount } = renderHook(
      () => useAmbientTrustIdAuth({ capturePayload }), { wrapper },
    );
    try {
      await act(async () => {});
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(faceLookup).toHaveBeenCalledTimes(1);
      const signal = faceLookup.mock.calls[0][0].signal as AbortSignal;
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
      expect(result.current.phase).toBe("ERROR");
      expect(result.current.error).toMatch(/BIOMETRIC_SERVICE_UNAVAILABLE/);
      expect(signal.aborted).toBe(true);
      await act(async () => { resolveLookup({ status: "NOT_FOUND", canRegister: true }); });
      expect(result.current.phase).toBe("ERROR");
      expect(capturePayload).toHaveBeenCalledTimes(1);
      expect(registerTrustId).not.toHaveBeenCalled();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("does not let an older no-match response stop a fresh retry", async () => {
    let resolveOld!: (value: unknown) => void;
    faceLookup.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    faceLookup.mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(
      () => useAmbientTrustIdAuth({ capturePayload: async () => facePayload() }), { wrapper },
    );
    await waitFor(() => expect(faceLookup).toHaveBeenCalledTimes(1));
    act(() => result.current.retry());
    await waitFor(() => expect(faceLookup).toHaveBeenCalledTimes(2));
    await act(async () => { resolveOld({ status: "NOT_FOUND", canRegister: true }); });
    expect(result.current.phase).toBe("PROMPTING");
    expect((faceLookup.mock.calls[1][0].signal as AbortSignal).aborted).toBe(false);
  });

  it("SERVICE_UNAVAILABLE is not treated as NO_MATCH", async () => {
    faceLookup.mockResolvedValue({
      status: "SERVICE_UNAVAILABLE",
      canRegister: false,
      message: "Biometric identification service unavailable",
      errorCode: "BIOMETRIC_SERVICE_UNAVAILABLE",
    });
    const capturePayload = vi.fn(async () => facePayload());
    const { result } = renderHook(
      () =>
        useAmbientTrustIdAuth({
          enabled: true,
          allowAutoEnroll: false,
          capturePayload,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.phase).toBe("ERROR"));
    expect(result.current.error).toMatch(/BIOMETRIC_SERVICE_UNAVAILABLE|unavailable/i);
    expect(result.current.phase).not.toBe("NO_MATCH");
    expect(registerTrustId).not.toHaveBeenCalled();
  });

  it("MATCH authenticates without entering NO_MATCH", async () => {
    faceLookup.mockResolvedValue({
      status: "MATCH_FOUND",
      trustId: "TD-EXIST01",
      identity: {
        trustId: "TD-EXIST01",
        status: "active",
        profile: { name: "Exist" },
        contacts: [],
      },
      sessionToken: "sess",
    });
    const capturePayload = vi.fn(async () => facePayload());
    const onAuthenticated = vi.fn();
    const { result } = renderHook(
      () =>
        useAmbientTrustIdAuth({
          enabled: true,
          allowAutoEnroll: false,
          capturePayload,
          onAuthenticated,
          storeSessionToken: async () => undefined,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.phase).toBe("AUTHENTICATED"), {
      timeout: 5000,
    });
    expect(onAuthenticated).toHaveBeenCalled();
  });

  it("registration creates the Trust ID and signs in", async () => {
    const capturePayload = vi.fn(async () => facePayload());
    const captureEnrollmentPayload = vi.fn(async () => facePayload());
    const registerFingerprintBackup = vi.fn(async () => false);
    const { result } = renderHook(
      () =>
        useAmbientTrustIdAuth({
          enabled: true,
          allowAutoEnroll: false,
          capturePayload,
          captureEnrollmentPayload,
          registerFingerprintBackup,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.phase).toBe("NO_MATCH"));

    act(() => {
      result.current.confirmCreateAccount();
    });

    await waitFor(() => expect(result.current.phase).toBe("AUTHENTICATED"));
    expect(registerTrustId).toHaveBeenCalled();
    const submitted = registerTrustId.mock.calls[0]?.[0] as {
      face?: { modelName?: string; vector?: number[]; embedding?: number[] };
    };
    expect(submitted.face?.modelName).toBe("insightface_arcface_w600k_mbf_v1");
    expect(submitted.face?.vector).toHaveLength(512);
    expect(submitted.face?.embedding).toBeUndefined();
    expect(captureEnrollmentPayload).not.toHaveBeenCalled();
    expect(registerFingerprintBackup).not.toHaveBeenCalled();
  });

  it("rejects legacy spatial identification probe and does not submit it", async () => {
    const legacyProbe = facePayload({
      modelName: "spatial_fallback_v1",
    });
    const capturePayload = vi.fn(async () => legacyProbe);
    const captureEnrollmentPayload = vi.fn(async () => ({}));
    const { result } = renderHook(
      () =>
        useAmbientTrustIdAuth({
          enabled: true,
          allowAutoEnroll: false,
          capturePayload,
          captureEnrollmentPayload,
        }),
      { wrapper },
    );

    // Legacy vectors never reach lookup / NO_MATCH � fail at vector stage.
    await waitFor(() => expect(result.current.phase).toBe("ERROR"));
    expect(faceLookup).not.toHaveBeenCalled();
    expect(registerTrustId).not.toHaveBeenCalled();
    expect(result.current.error).toBe(BIOMETRIC_UNAVAILABLE_ERROR);
    expect(result.current.faceDiagnostics.errorCode).toBe(
      "FACE_VECTOR_UNAVAILABLE",
    );
  });

  it("reuses ArcFace NO_MATCH probe when enrollment capture is empty", async () => {
    const idProbe = facePayload({ confidence: 0.88 });
    const capturePayload = vi.fn(async () => idProbe);
    const captureEnrollmentPayload = vi.fn(async () => ({}));
    const { result } = renderHook(
      () =>
        useAmbientTrustIdAuth({
          enabled: true,
          allowAutoEnroll: false,
          capturePayload,
          captureEnrollmentPayload,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.phase).toBe("NO_MATCH"));
    expect(result.current.faceDiagnostics.vectorCreated).toBe(true);
    expect(result.current.faceDiagnostics.errorCode).toBe("FACE_NOT_ENROLLED");
    act(() => {
      result.current.confirmCreateAccount();
    });
    await waitFor(() => expect(result.current.phase).toBe("AUTHENTICATED"));
    expect(captureEnrollmentPayload).not.toHaveBeenCalled();
    const submitted = registerTrustId.mock.calls[0]?.[0] as {
      face?: { confidence?: number; modelName?: string };
    };
    expect(submitted.face?.modelName).toBe("insightface_arcface_w600k_mbf_v1");
    expect(submitted.face?.confidence).toBe(0.88);
    expect(result.current.faceDiagnostics.templateAvailable).toBe(true);
  });

  it("creates the Trust ID from the first scanned face", async () => {
    const idProbe = facePayload({ confidence: 0.5 });
    const enrollFace = facePayload({ confidence: 0.95 });
    const capturePayload = vi.fn(async () => idProbe);
    const captureEnrollmentPayload = vi.fn(async () => enrollFace);
    const { result } = renderHook(
      () =>
        useAmbientTrustIdAuth({
          enabled: true,
          allowAutoEnroll: false,
          capturePayload,
          captureEnrollmentPayload,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.phase).toBe("NO_MATCH"));
    act(() => {
      result.current.confirmCreateAccount();
    });
    await waitFor(() => expect(result.current.phase).toBe("AUTHENTICATED"));
    expect(captureEnrollmentPayload).not.toHaveBeenCalled();
    const submitted = registerTrustId.mock.calls[0]?.[0] as {
      face?: { confidence?: number };
    };
    expect(submitted.face?.confidence).toBe(0.5);
  });

  it("Create TrustID captures a face when the scan ended without one, then signs in", async () => {
    const capturePayload = vi
      .fn()
      .mockResolvedValueOnce({
        captureErrorCode: "NO_FACE",
        captureErrorMessage: "Capture aborted",
      })
      .mockResolvedValueOnce(facePayload({ confidence: 0.81 }));
    const { result } = renderHook(
      () => useAmbientTrustIdAuth({ capturePayload }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.phase).toBe("FACE_NOT_READ"));
    expect(faceLookup).not.toHaveBeenCalled();
    act(() => {
      result.current.confirmCreateAccount();
    });
    await waitFor(() => expect(result.current.phase).toBe("AUTHENTICATED"));
    expect(capturePayload).toHaveBeenCalledTimes(2);
    expect(faceLookup).not.toHaveBeenCalled();
    const submitted = registerTrustId.mock.calls[0]?.[0] as {
      face?: { confidence?: number };
    };
    expect(submitted.face?.confidence).toBe(0.81);
  });

  it("stale scan result cannot overwrite a newer user-choice phase", async () => {
    let resolveLookup: (v: unknown) => void = () => undefined;
    faceLookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const capturePayload = vi.fn(async () => facePayload());
    const { result } = renderHook(
      () =>
        useAmbientTrustIdAuth({
          enabled: true,
          allowAutoEnroll: false,
          capturePayload,
        }),
      { wrapper },
    );

    await waitFor(() => expect(capturePayload).toHaveBeenCalled());

    // User somehow lands on NO_MATCH while old lookup still pending
    act(() => {
      result.current.retry();
    });

    // Late NOT_FOUND from attempt A
    await act(async () => {
      resolveLookup({ status: "NOT_FOUND", canRegister: true });
      await new Promise((r) => setTimeout(r, 50));
    });

    // Must not bounce out of an in-progress retry into a confused state forever
    await waitFor(() => {
      expect(["PROMPTING", "CHECKING", "NO_MATCH", "ERROR"]).toContain(
        result.current.phase,
      );
    });
  });
});

const RAW_WASM_ERROR =
  "Biometric model init failed (MediaPipe=SUCCESS, ArcFace=FAILURE): no available backend found. ERR: [wasm] Error: multiple calls to 'initWasm()' detected.";

describe("biometric runtime unavailable", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    resetEnrollmentCandidateForDev();
    faceLookup.mockResolvedValue({ status: "NOT_FOUND", canRegister: true });
  });

  it("a runtime init failure is a service error, never a not-found, and hides the internal error", async () => {
    const capturePayload = vi.fn(async () => ({
      captureErrorCode: "BIOMETRIC_MODEL_UNAVAILABLE",
      captureErrorMessage: RAW_WASM_ERROR,
    }));
    const view = render(
      <TrustIdAmbientAuthProvider capturePayload={capturePayload}>
        Signed in
      </TrustIdAmbientAuthProvider>,
      { wrapper },
    );
    await screen.findByText(/BIOMETRIC SERVICE UNAVAILABLE/, undefined, { timeout: 8000 });
    expect(
      screen.getByText(
        "BIOMETRIC SERVICE UNAVAILABLE — TrustID couldn't start biometric verification on this device. Retry or use another available verification method.",
      ),
    ).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/initWasm|no available backend|ArcFace|wasm/i);
    expect(view.container.textContent).not.toMatch(/No Trust ID found/);
    expect(screen.queryByRole("button", { name: "Create TrustID" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry Face Scan" })).toBeTruthy();
    expect(faceLookup).not.toHaveBeenCalled();
    expect(registerTrustId).not.toHaveBeenCalled();
    view.unmount();
  }, 15000);

  it("a page-level runtime failure offers reload instead of a retry that cannot work", async () => {
    const capturePayload = vi.fn(async () => ({
      captureErrorCode: "BIOMETRIC_MODEL_UNAVAILABLE",
      captureErrorMessage:
        "Biometric model init failed (MediaPipe=SUCCESS, ArcFace=FAILURE): BIOMETRIC_RUNTIME_FAILED: biometric runtime unavailable (init)",
    }));
    const view = render(
      <TrustIdAmbientAuthProvider capturePayload={capturePayload}>
        Signed in
      </TrustIdAmbientAuthProvider>,
      { wrapper },
    );
    await screen.findByRole("button", { name: "Reload Page" }, { timeout: 8000 });
    expect(screen.queryByRole("button", { name: "Retry Face Scan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create TrustID" })).toBeNull();
    expect(view.container.textContent).not.toMatch(/BIOMETRIC_RUNTIME_FAILED/);
    view.unmount();
  }, 15000);

  it("Create TrustID never registers when biometrics cannot start", async () => {
    const capturePayload = vi
      .fn()
      .mockResolvedValueOnce({
        captureErrorCode: "NO_FACE",
        captureErrorMessage: "Capture aborted",
      })
      .mockResolvedValueOnce({
        captureErrorCode: "BIOMETRIC_MODEL_UNAVAILABLE",
        captureErrorMessage: RAW_WASM_ERROR,
      });
    const { result } = renderHook(
      () => useAmbientTrustIdAuth({ capturePayload }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.phase).toBe("FACE_NOT_READ"));
    act(() => {
      result.current.confirmCreateAccount();
    });
    await waitFor(() => expect(capturePayload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.phase).toBe("ERROR"));
    expect(result.current.error).toBe(BIOMETRIC_UNAVAILABLE_ERROR);
    expect(registerTrustId).not.toHaveBeenCalled();
    expect(faceLookup).not.toHaveBeenCalled();
    expect(result.current.faceDiagnostics.errorCode).toBe("BIOMETRIC_MODEL_UNAVAILABLE");
  });

  it("a scan that ends without reading a face does not claim no Trust ID exists", async () => {
    vi.useFakeTimers();
    const capturePayload = vi.fn(() => new Promise(() => {}));
    const view = render(
      <TrustIdAmbientAuthProvider capturePayload={capturePayload as never}>
        Signed in
      </TrustIdAmbientAuthProvider>,
      { wrapper },
    );
    try {
      await act(async () => {});
      await act(async () => { await vi.advanceTimersByTimeAsync(46_000); });
      expect(view.container.textContent).toMatch(/We couldn't read your face/);
      expect(view.container.textContent).toMatch(/doesn't mean you don't have a TrustID/);
      expect(view.container.textContent).toMatch(/still loading/);
      expect(view.container.textContent).not.toMatch(/No Trust ID found|No TrustID matches|New here/);
      expect(screen.getByRole("button", { name: "Retry Face Scan" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Use Fingerprint" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Create TrustID" })).toBeTruthy();
      expect((capturePayload.mock.calls[0] as unknown as [{ signal: AbortSignal }])[0].signal.aborted).toBe(true);
      expect(faceLookup).not.toHaveBeenCalled();
      expect(registerTrustId).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
});

type CaptureOpts = { signal?: AbortSignal; onState?: (state: string) => void };

describe("face not read", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    resetEnrollmentCandidateForDev();
    faceLookup.mockResolvedValue({ status: "NOT_FOUND", canRegister: true });
  });

  it("a scan window that runs out after detection started reports SCAN_TIMEOUT", async () => {
    vi.useFakeTimers();
    const capturePayload = vi.fn((opts?: CaptureOpts) => {
      opts?.onState?.("PREPARING_MODELS");
      opts?.onState?.("DETECTING");
      return new Promise<never>(() => {});
    });
    const { result, unmount } = renderHook(
      () => useAmbientTrustIdAuth({ capturePayload: capturePayload as never }),
      { wrapper },
    );
    try {
      await act(async () => {});
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(result.current.scanStage).toBe("scanning");
      await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
      expect(result.current.phase).toBe("FACE_NOT_READ");
      expect(result.current.faceScanReason).toBe("SCAN_TIMEOUT");
      expect(faceLookup).not.toHaveBeenCalled();
      expect(registerTrustId).not.toHaveBeenCalled();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("shows the reason hint and counters, without claiming the user is new", async () => {
    const capturePayload = vi.fn(async () => ({
      captureErrorCode: "LOW_QUALITY",
      captureErrorMessage: "Too dark to read the face",
      captureReasonCode: "LOW_LIGHT",
      captureDiagnostics: {
        reason: "LOW_LIGHT",
        finalState: "FAILED",
        inferenceMirrored: false,
        counters: {
          framesObserved: 40, framesSubmitted: 31, blankFrames: 0, darkFrames: 9,
          staleFrames: 2, detectorSuccesses: 31, detectorErrors: 0, facesDetected: 12,
          multipleFaces: 0, qualityAccepted: 0, qualityRejected: 12,
          embeddingAttempts: 0, embeddingFailures: 0,
        },
      },
    }));
    const view = render(
      <TrustIdAmbientAuthProvider capturePayload={capturePayload as never}>
        Signed in
      </TrustIdAmbientAuthProvider>,
      { wrapper },
    );
    await screen.findByText("We couldn't read your face", undefined, { timeout: 8000 });
    expect(view.container.textContent).toMatch(/Move somewhere brighter/);
    expect(screen.getByTestId("face-scan-diagnostics").textContent).toBe(
      "LOW_LIGHT · frames 40/31 · faces 12 · accepted 0",
    );
    expect(view.container.textContent).not.toMatch(/No Trust ID found|New here/);
    expect(faceLookup).not.toHaveBeenCalled();
    expect(registerTrustId).not.toHaveBeenCalled();
    view.unmount();
  }, 15000);

  it("a detector failure is a service error, not 'couldn't read your face'", async () => {
    const capturePayload = vi.fn(async () => ({
      captureErrorCode: "DETECTOR_ERROR",
      captureErrorMessage: "Face detector failed on every frame",
      captureReasonCode: "DETECTOR_ERROR",
    }));
    const { result } = renderHook(
      () => useAmbientTrustIdAuth({ capturePayload: capturePayload as never }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.phase).toBe("ERROR"));
    expect(result.current.error).toBe(BIOMETRIC_UNAVAILABLE_ERROR);
    expect(registerTrustId).not.toHaveBeenCalled();
  });

  it("Retry Face Scan after a failed scan starts exactly one new scan", async () => {
    const capturePayload = vi.fn(async () => ({
      captureErrorCode: "NO_FACE",
      captureErrorMessage: "No face found in the camera view",
      captureReasonCode: "NO_FACE_DETECTED",
    }));
    const view = render(
      <TrustIdAmbientAuthProvider capturePayload={capturePayload as never}>
        Signed in
      </TrustIdAmbientAuthProvider>,
      { wrapper },
    );
    const retry = await screen.findByRole("button", { name: "Retry Face Scan" }, { timeout: 8000 });
    expect(capturePayload).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await waitFor(() => expect(capturePayload).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await screen.findByText("We couldn't read your face", undefined, { timeout: 8000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    expect(capturePayload).toHaveBeenCalledTimes(2);
    expect(registerTrustId).not.toHaveBeenCalled();
    view.unmount();
  }, 15000);

  it("a failed fingerprint unlock stays on the face-not-read screen", async () => {
    const capturePayload = vi.fn(async () => ({
      captureErrorCode: "NO_FACE",
      captureErrorMessage: "No face found in the camera view",
      captureReasonCode: "NO_FACE_DETECTED",
    }));
    const { result } = renderHook(
      () => useAmbientTrustIdAuth({ capturePayload: capturePayload as never }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.phase).toBe("FACE_NOT_READ"));
    act(() => {
      result.current.useFingerprintLogin();
    });
    await waitFor(() => expect(result.current.fingerprintBusy).toBe(false));
    expect(result.current.phase).toBe("FACE_NOT_READ");
  });

  it("StrictMode double mount keeps a single live scan", async () => {
    const signals: AbortSignal[] = [];
    const capturePayload = vi.fn((opts?: CaptureOpts) => {
      if (opts?.signal) signals.push(opts.signal);
      return new Promise<never>(() => {});
    });
    const view = render(
      <StrictMode>
        <TrustIdAmbientAuthProvider capturePayload={capturePayload as never}>
          Signed in
        </TrustIdAmbientAuthProvider>
      </StrictMode>,
      { wrapper },
    );
    await waitFor(() => expect(signals.length).toBeGreaterThan(0), { timeout: 5000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    expect(signals.filter((s) => !s.aborted)).toHaveLength(1);
    view.unmount();
    expect(signals.every((s) => s.aborted)).toBe(true);
  }, 15000);

  it("leaving and returning to the page aborts the old scan and starts one new scan", async () => {
    const signals: AbortSignal[] = [];
    const capturePayload = vi.fn((opts?: CaptureOpts) => {
      if (opts?.signal) signals.push(opts.signal);
      return new Promise<never>(() => {});
    });
    const tree = () => (
      <TrustIdAmbientAuthProvider capturePayload={capturePayload as never}>
        Signed in
      </TrustIdAmbientAuthProvider>
    );
    const first = render(tree(), { wrapper });
    await waitFor(() => expect(signals).toHaveLength(1), { timeout: 5000 });
    first.unmount();
    expect(signals[0]!.aborted).toBe(true);
    const second = render(tree(), { wrapper });
    await waitFor(() => expect(signals).toHaveLength(2), { timeout: 5000 });
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    expect(signals.filter((s) => !s.aborted)).toHaveLength(1);
    second.unmount();
  }, 15000);
});
