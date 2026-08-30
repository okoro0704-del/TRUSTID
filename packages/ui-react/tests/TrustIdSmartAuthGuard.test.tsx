import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TrustIdAuthProvider } from "../src/context/TrustIdAuthProvider.js";
import { TrustIdSmartAuthGuard } from "../src/components/TrustIdSmartAuthGuard.js";
import {
  __setWebAuthnProbeTimeoutMs,
  clearSilentAutoLoginAttempt,
  resetSilentWebLoginInflight,
} from "../src/lib/silentAuth.js";
import type { TrustIdApiClient } from "../src/api/client.js";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(async () => {
    throw new Error("NotAllowedError: no credentials");
  }),
  startRegistration: vi.fn(async () => ({ id: "new-cred", response: {} })),
  base64URLStringToBuffer: (s: string) => new TextEncoder().encode(s).buffer,
  bufferToBase64URLString: () => "b64",
}));

function mockApi(): TrustIdApiClient {
  return {
    getBaseUrl: () => "/api",
    fetch: vi.fn(async (path: string) => {
      if (path === "/auth/session") throw new Error("unauthorized");
      if (path === "/auth/webauthn/login/options") {
        return { challenge: "abc", rpId: "localhost", allowCredentials: [] };
      }
      if (path === "/v1/auth/silent-assert") {
        throw new Error("NotAllowedError: no credentials");
      }
      if (path === "/v1/auth/register-silent/options") {
        return {
          userId: "user_1",
          trustId: "TD-NEW00001",
          options: {
            challenge: "reg",
            rp: { id: "localhost", name: "TrustID" },
            user: { id: "u", name: "TD", displayName: "TD" },
          },
        };
      }
      if (path === "/v1/auth/register-silent") {
        return {
          trustId: "TD-NEW00001",
          identity: {
            trustId: "TD-NEW00001",
            status: "active",
            profile: { firstName: "Trust", lastName: "ID", name: "Trust ID" },
            contacts: [],
          },
        };
      }
      throw new Error(`unexpected ${path}`);
    }),
  };
}

describe("TrustIdSmartAuthGuard", () => {
  beforeEach(() => {
    clearSilentAutoLoginAttempt();
    resetSilentWebLoginInflight();
    __setWebAuthnProbeTimeoutMs(5000);
    vi.clearAllMocks();
  });

  afterEach(() => {
    __setWebAuthnProbeTimeoutMs(5000);
    resetSilentWebLoginInflight();
  });

  it("shows Create Trust ID when no passkey is found, then completes silent register", async () => {
    const user = userEvent.setup();
    const apiClient = mockApi();

    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        get: vi.fn(async () => {
          throw new DOMException(
            "The operation was aborted.",
            "NotAllowedError",
          );
        }),
      },
    });

    render(
      <TrustIdAuthProvider apiClient={apiClient} enableRealtime={false}>
        <TrustIdSmartAuthGuard getInstallId={async () => "install-test"}>
          <div>Unlocked app</div>
        </TrustIdSmartAuthGuard>
      </TrustIdAuthProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: /create trust id passkey with face id \/ fingerprint/i,
        }),
      ).toBeInTheDocument(),
    );

    expect(
      screen.getByText(/no active trust id passkey was found/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/unlocking with face id/i),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: /create trust id passkey with face id \/ fingerprint/i,
      }),
    );

    await waitFor(() =>
      expect(screen.getByText("Unlocked app")).toBeInTheDocument(),
    );
    expect(apiClient.fetch).toHaveBeenCalledWith(
      "/v1/auth/register-silent",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("exits biometric spinner when WebAuthn hangs past the probe timeout", async () => {
    __setWebAuthnProbeTimeoutMs(40);
    const apiClient = mockApi();

    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        get: vi.fn(() => new Promise(() => {})),
      },
    });

    render(
      <TrustIdAuthProvider apiClient={apiClient} enableRealtime={false}>
        <TrustIdSmartAuthGuard getInstallId={async () => "install-timeout"}>
          <div>Unlocked app</div>
        </TrustIdSmartAuthGuard>
      </TrustIdAuthProvider>,
    );

    await waitFor(
      () =>
        expect(
          screen.getByRole("button", {
            name: /create trust id passkey with face id \/ fingerprint/i,
          }),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(
      screen.queryByText(/unlocking with face id/i),
    ).not.toBeInTheDocument();
  });
});
