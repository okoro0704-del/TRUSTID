import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { WEBAUTHN_PURPOSES } from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import {
  consumeWebAuthnChallenge,
  createSecureChallenge,
  extractClientChallenge,
  storeWebAuthnChallenge,
} from "../src/modules/authentication/challenges.js";
import { resetTables } from "./helpers/db.js";

describe("WebAuthn challenges", () => {
  beforeEach(async () => {
    await resetTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates cryptographically strong challenges", () => {
    const a = createSecureChallenge();
    const b = createSecureChallenge();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("consumes a valid challenge once", async () => {
    const challenge = createSecureChallenge();
    await storeWebAuthnChallenge({
      purpose: WEBAUTHN_PURPOSES.REGISTRATION,
      challenge,
      userId: null,
    });
    const first = await consumeWebAuthnChallenge({
      challenge,
      purpose: WEBAUTHN_PURPOSES.REGISTRATION,
    });
    expect(first.ok).toBe(true);
    const second = await consumeWebAuthnChallenge({
      challenge,
      purpose: WEBAUTHN_PURPOSES.REGISTRATION,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("consumed");
  });

  it("rejects expired challenges", async () => {
    const challenge = createSecureChallenge();
    await storeWebAuthnChallenge({
      purpose: WEBAUTHN_PURPOSES.AUTHENTICATION,
      challenge,
      ttlMs: -1000,
    });
    const result = await consumeWebAuthnChallenge({
      challenge,
      purpose: WEBAUTHN_PURPOSES.AUTHENTICATION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects purpose mismatch", async () => {
    const challenge = createSecureChallenge();
    await storeWebAuthnChallenge({
      purpose: WEBAUTHN_PURPOSES.REGISTRATION,
      challenge,
    });
    const result = await consumeWebAuthnChallenge({
      challenge,
      purpose: WEBAUTHN_PURPOSES.AUTHENTICATION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("purpose_mismatch");
  });

  it("extracts challenge from clientDataJSON", () => {
    const payload = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge: "abc123", origin: "http://localhost:5173" }),
    ).toString("base64url");
    expect(extractClientChallenge(payload)).toBe("abc123");
  });
});
