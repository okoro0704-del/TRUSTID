import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TrustIdAuthProvider } from "../src/context/TrustIdAuthProvider.js";
import { TrustIdLoginButton } from "../src/components/TrustIdLoginButton.js";
import type { TrustIdApiClient } from "../src/api/client.js";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(async () => ({ id: "assertion" })),
}));

function mockApi(): TrustIdApiClient {
  return {
    getBaseUrl: () => "/api",
    fetch: vi.fn(async (path: string) => {
      if (path === "/auth/session") {
        return { identity: null };
      }
      if (path === "/auth/webauthn/login/options") {
        return { challenge: "abc", rpId: "localhost", allowCredentials: [] };
      }
      if (path === "/v1/auth/silent-assert") {
        return {
          identity: {
            trustId: "tid_test",
            status: "active",
            profile: { firstName: "T", lastName: "U", name: "T U" },
            contacts: [],
          },
          trustId: "tid_test",
          mode: "webauthn",
        };
      }
      if (path === "/auth/webauthn/login/verify") {
        return {
          identity: {
            trustId: "tid_test",
            status: "active",
            profile: { firstName: "T", lastName: "U", name: "T U" },
            contacts: [],
          },
        };
      }
      throw new Error(`unexpected ${path}`);
    }),
  };
}

describe("TrustIdLoginButton", () => {
  it("silent Login invokes zero-input passkey assert without opening a form", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const apiClient = mockApi();

    render(
      <TrustIdAuthProvider apiClient={apiClient} enableRealtime={false}>
        <TrustIdLoginButton onSuccess={onSuccess} />
      </TrustIdAuthProvider>,
    );

    await user.click(screen.getByRole("button", { name: /login/i }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(apiClient.fetch).toHaveBeenCalledWith(
      "/v1/auth/silent-assert",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"mode":"webauthn"'),
      }),
    );
    // No email/phone fields in the primary silent path
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/phone/i)).not.toBeInTheDocument();
  });
});
