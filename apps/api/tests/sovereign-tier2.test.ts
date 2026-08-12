import { describe, expect, it } from "vitest";
import {
  evaluateAttestation,
  normalizeAaguid,
} from "../src/modules/attestation/mds.js";
import {
  combineShares,
  commitSecret,
  splitSecret,
} from "@trustid/sovereign-crypto";

describe("attestation MDS policy", () => {
  it("normalizes AAGUID hex", () => {
    expect(normalizeAaguid("08987058cadc4b81b6e130de50dcbe96")).toBe(
      "08987058-cadc-4b81-b6e1-30de50dcbe96",
    );
  });

  it("accepts Windows Hello hardware under tee minimum", () => {
    const r = evaluateAttestation({
      aaguid: "08987058-cadc-4b81-b6e1-30de50dcbe96",
      policy: {
        mode: "strict",
        attestationType: "direct",
        minSecurityLevel: "tee",
        requireKnownAaguid: true,
      },
    });
    expect(r.status).toBe("accepted");
    expect(r.securityLevel).toBe("secure_hardware");
  });

  it("rejects software authenticator in strict mode", () => {
    const r = evaluateAttestation({
      aaguid: "6028b017-b1d4-4c02-b4b3-afcdafc96bb2",
      policy: {
        mode: "strict",
        attestationType: "direct",
        minSecurityLevel: "tee",
        requireKnownAaguid: true,
      },
    });
    expect(r.status).toBe("rejected");
  });

  it("soft-fails unknown AAGUID when required", () => {
    const r = evaluateAttestation({
      aaguid: "11111111-1111-1111-1111-111111111111",
      policy: {
        mode: "soft",
        attestationType: "direct",
        minSecurityLevel: "tee",
        requireKnownAaguid: true,
      },
    });
    expect(r.status).toBe("soft_fail");
  });
});

describe("Shamir recovery shares", () => {
  it("reconstructs with threshold shares", async () => {
    const secret = new TextEncoder().encode("sovereign-recovery-secret-32b!!");
    const shares = splitSecret(secret, 3, 5);
    const out = combineShares([shares[0]!, shares[2]!, shares[4]!]);
    expect(new TextDecoder().decode(out)).toBe("sovereign-recovery-secret-32b!!");
    const c = await commitSecret(secret);
    expect(c.length).toBeGreaterThan(20);
  });
});
