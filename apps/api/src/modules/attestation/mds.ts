/**
 * Local FIDO authenticator metadata catalog (MDS-inspired).
 * Production can overlay entries from FIDO MDS JWT blobs via MDS_URL.
 *
 * securityLevel:
 * - secure_hardware: TPM / Secure Enclave / StrongBox class
 * - tee: Trusted Execution Environment
 * - software: software authenticator (rejected when policy requires hardware)
 */

export type MdsEntry = {
  aaguid: string;
  description: string;
  securityLevel: "secure_hardware" | "tee" | "software";
  protocolFamily?: string;
};

/** Well-known platform authenticator AAGUIDs (subset; extend via env/MDS fetch). */
export const BUILTIN_MDS_CATALOG: MdsEntry[] = [
  {
    aaguid: "00000000-0000-0000-0000-000000000000",
    description: "Unspecified / legacy platform",
    securityLevel: "software",
  },
  // Windows Hello (common)
  {
    aaguid: "08987058-cadc-4b81-b6e1-30de50dcbe96",
    description: "Windows Hello Hardware Authenticator",
    securityLevel: "secure_hardware",
  },
  {
    aaguid: "6028b017-b1d4-4c02-b4b3-afcdafc96bb2",
    description: "Windows Hello Software Authenticator",
    securityLevel: "software",
  },
  // Apple
  {
    aaguid: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
    description: "Apple iCloud Keychain / platform",
    securityLevel: "secure_hardware",
  },
  {
    aaguid: "dd4ec289-e01d-41c9-bb89-70d55ebf2e66",
    description: "Apple Secure Enclave",
    securityLevel: "secure_hardware",
  },
  // Google Password Manager / Android
  {
    aaguid: "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4",
    description: "Google Password Manager",
    securityLevel: "tee",
  },
  {
    aaguid: "9ddd1817-af5a-4672-a2b9-3e3dd50f4f0a",
    description: "Android Platform Authenticator",
    securityLevel: "tee",
  },
];

const LEVEL_RANK: Record<MdsEntry["securityLevel"], number> = {
  software: 0,
  tee: 1,
  secure_hardware: 2,
};

export type AttestationPolicy = {
  /** off | soft | strict */
  mode: "off" | "soft" | "strict";
  /** WebAuthn attestation conveyance */
  attestationType: "none" | "direct" | "enterprise";
  minSecurityLevel: MdsEntry["securityLevel"];
  requireKnownAaguid: boolean;
};

export type AttestationEvaluation = {
  status: "accepted" | "soft_fail" | "rejected";
  securityLevel: MdsEntry["securityLevel"] | "unknown";
  reason: string;
  mdsDescription?: string;
};

export function normalizeAaguid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hex = raw.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  if (hex.length !== 32) {
    // already dashed?
    const m = raw.toLowerCase().match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    return m ? raw.toLowerCase() : null;
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function lookupMds(
  aaguid: string | null | undefined,
  catalog: MdsEntry[] = BUILTIN_MDS_CATALOG,
): MdsEntry | null {
  const id = normalizeAaguid(aaguid);
  if (!id) return null;
  return catalog.find((e) => e.aaguid === id) ?? null;
}

export function evaluateAttestation(input: {
  aaguid: string | null | undefined;
  attestationFormat?: string | null;
  policy: AttestationPolicy;
  catalog?: MdsEntry[];
}): AttestationEvaluation {
  if (input.policy.mode === "off") {
    return {
      status: "accepted",
      securityLevel: "unknown",
      reason: "attestation_policy_off",
    };
  }

  const entry = lookupMds(input.aaguid, input.catalog);
  if (!entry) {
    if (input.policy.requireKnownAaguid || input.policy.mode === "strict") {
      const evalResult: AttestationEvaluation = {
        status: input.policy.mode === "strict" ? "rejected" : "soft_fail",
        securityLevel: "unknown",
        reason: "unknown_aaguid",
      };
      return evalResult;
    }
    return {
      status: "accepted",
      securityLevel: "unknown",
      reason: "unknown_aaguid_allowed",
    };
  }

  const have = LEVEL_RANK[entry.securityLevel];
  const need = LEVEL_RANK[input.policy.minSecurityLevel];
  if (have < need) {
    return {
      status: input.policy.mode === "strict" ? "rejected" : "soft_fail",
      securityLevel: entry.securityLevel,
      reason: "security_level_below_minimum",
      mdsDescription: entry.description,
    };
  }

  return {
    status: "accepted",
    securityLevel: entry.securityLevel,
    reason: "mds_ok",
    mdsDescription: entry.description,
  };
}
