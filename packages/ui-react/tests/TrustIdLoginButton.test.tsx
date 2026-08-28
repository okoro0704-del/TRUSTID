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
        return { challenge: "abc", rpId: "localhost" };
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
  it("opens modal and completes passkey login", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const apiClient = mockApi();

    render(
      <TrustIdAuthProvider apiClient={apiClient} enableRealtime={false}>
        <TrustIdLoginButton onSuccess={onSuccess} />
      </TrustIdAuthProvider>,
    );

    await user.click(screen.getByRole("button", { name: /sign in with passkey/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /continue with passkey/i }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });
});
