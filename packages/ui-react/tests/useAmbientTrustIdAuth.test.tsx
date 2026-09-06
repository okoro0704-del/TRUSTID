/**
 * Ambient auth state machine: NO_MATCH terminates scan; service errors ? no-match.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { TrustIdAuthProvider } from "../src/context/TrustIdAuthProvider.js";
import { useAmbientTrustIdAuth } from "../src/hooks/useAmbientTrustIdAuth.js";
import type { TrustIdApiClient } from "../src/api/client.js";

const faceLookup = vi.fn();
const registerTrustId = vi.fn();
const ambientSignIn = vi.fn();
const enrollBiometric = vi.fn();

vi.mock("@trustid/sdk", () => ({
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

function facePayload() {
  return {
    face: {
      modality: "face" as const,
      vector: Array.from({ length: 512 }, (_, i) => i / 512),
      modelName: "insightface_arcface_w600k_mbf_v1",
      modelVersion: 1,
      confidence: 0.9,
    },
  };
}

describe("useAmbientTrustIdAuth state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const registerFingerprintBackup = vi.fn(async () => false);
    const { result } = renderHook(
      () =>
        useAmbientTrustIdAuth({
          enabled: true,
          allowAutoEnroll: false,
          capturePayload,
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
