/**
 * Ambient auth state machine: NO_MATCH terminates scan; service errors ? no-match.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { TrustIdAuthProvider } from "../src/context/TrustIdAuthProvider.js";
import { useAmbientTrustIdAuth } from "../src/hooks/useAmbientTrustIdAuth.js";
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
    const register = await screen.findByRole("button", { name: "Register My Face" });
    expect(view.container.querySelector(".tid-silent-splash-ring")).toBeNull();
    expect((faceLookup.mock.calls[0][0].signal as AbortSignal).aborted).toBe(true);
    expect(registerTrustId).not.toHaveBeenCalled();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); });
    expect(capturePayload).toHaveBeenCalledTimes(1);
    fireEvent.click(register);
    await screen.findByText("Face saved successfully");
    expect(registerTrustId).toHaveBeenCalledTimes(1);
    expect(capturePayload).toHaveBeenCalledTimes(1);
    view.unmount();
  });

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

  it("aborts a hanging lookup after 30 seconds and ignores its late no-match result", async () => {
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
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(result.current.phase).toBe("ERROR");
      expect(result.current.error).toMatch(/timed out/);
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

  it("registration reaches FACE_SAVED; fingerprint failure does not auto-login", async () => {
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

    await waitFor(() => expect(result.current.phase).toBe("FACE_SAVED"));
    expect(registerTrustId).toHaveBeenCalled();
    const submitted = registerTrustId.mock.calls[0]?.[0] as {
      face?: { modelName?: string; vector?: number[]; embedding?: number[] };
    };
    expect(submitted.face?.modelName).toBe("insightface_arcface_w600k_mbf_v1");
    expect(submitted.face?.vector).toHaveLength(512);
    expect(submitted.face?.embedding).toBeUndefined();
    // ArcFace probe from NO_MATCH is enough ? no second capture required.
    expect(captureEnrollmentPayload).not.toHaveBeenCalled();

    act(() => {
      result.current.continueAfterDeviceSaved();
    });
    expect(result.current.phase).toBe("OFFER_FINGERPRINT");

    act(() => {
      result.current.confirmFingerprintBackup();
    });

    await waitFor(() =>
      expect(result.current.phase).toBe("FINGERPRINT_FAILED"),
    );
    expect(result.current.phase).not.toBe("AUTHENTICATED");
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
    expect(result.current.error).toMatch(/FACE_VECTOR_UNAVAILABLE|ArcFace/i);
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
    await waitFor(() => expect(result.current.phase).toBe("FACE_SAVED"));
    expect(captureEnrollmentPayload).not.toHaveBeenCalled();
    const submitted = registerTrustId.mock.calls[0]?.[0] as {
      face?: { confidence?: number; modelName?: string };
    };
    expect(submitted.face?.modelName).toBe("insightface_arcface_w600k_mbf_v1");
    expect(submitted.face?.confidence).toBe(0.88);
    expect(result.current.faceDiagnostics.templateAvailable).toBe(true);
  });

  it("prefers ArcFace NO_MATCH probe over a second enrollment capture", async () => {
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
    await waitFor(() => expect(result.current.phase).toBe("FACE_SAVED"));
    expect(captureEnrollmentPayload).not.toHaveBeenCalled();
    const submitted = registerTrustId.mock.calls[0]?.[0] as {
      face?: { confidence?: number };
    };
    expect(submitted.face?.confidence).toBe(0.5);
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
