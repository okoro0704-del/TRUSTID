import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TrustIdAuthProvider } from "../src/context/TrustIdAuthProvider.js";
import { AutoAuthGuard } from "../src/components/AutoAuthGuard.js";
import { useSilentAutoLogin } from "../src/hooks/useSilentAutoLogin.js";
import { clearSilentAutoLoginAttempt } from "../src/lib/silentAuth.js";
import type { TrustIdApiClient } from "../src/api/client.js";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(async () => ({ id: "assertion", response: {} })),
  base64URLStringToBuffer: (s: string) => new TextEncoder().encode(s).buffer,
  bufferToBase64URLString: () => "b64",
}));

function mockApi(authenticated = false): TrustIdApiClient {
  return {
    getBaseUrl: () => "/api",
    fetch: vi.fn(async (path: string) => {
      if (path === "/auth/session") {
        if (authenticated) {
          return {
            identity: {
              trustId: "TD-TEST0001",
              status: "active",
              profile: { firstName: "T", lastName: "U", name: "T U" },
              contacts: [],
            },
          };
        }
        throw new Error("unauthorized");
      }
      if (path === "/auth/webauthn/login/options") {
        return { challenge: "abc", rpId: "localhost", allowCredentials: [] };
      }
      if (path === "/v1/auth/silent-assert") {
        return {
          identity: {
            trustId: "TD-TEST0001",
            status: "active",
            profile: { firstName: "T", lastName: "U", name: "T U" },
            contacts: [],
          },
          trustId: "TD-TEST0001",
          mode: "webauthn",
        };
      }
      throw new Error(`unexpected ${path}`);
    }),
  };
}

function Probe() {
  const { status, prompting } = useSilentAutoLogin({ enabled: true });
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="prompting">{String(prompting)}</span>
    </div>
  );
}

describe("useSilentAutoLogin + AutoAuthGuard", () => {
  beforeEach(() => {
    clearSilentAutoLoginAttempt();
    vi.clearAllMocks();
  });

  it("auto-runs silent assert and reaches success", async () => {
    const apiClient = mockApi(false);
    render(
      <TrustIdAuthProvider apiClient={apiClient} enableRealtime={false}>
        <Probe />
      </TrustIdAuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("success"),
    );
    expect(apiClient.fetch).toHaveBeenCalledWith(
      "/v1/auth/silent-assert",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("AutoAuthGuard reveals children after authenticated session", async () => {
    const apiClient = mockApi(true);
    render(
      <TrustIdAuthProvider apiClient={apiClient} enableRealtime={false}>
        <AutoAuthGuard>
          <div>Protected app</div>
        </AutoAuthGuard>
      </TrustIdAuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText("Protected app")).toBeInTheDocument(),
    );
  });
});
