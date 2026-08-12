function trustIdApiBase(): string {
  if (import.meta.env.VITE_TRUSTID_API) {
    return String(import.meta.env.VITE_TRUSTID_API).replace(/\/$/, "");
  }
  if (
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1")
  ) {
    return "http://localhost:8787";
  }
  throw new Error(
    "Set VITE_TRUSTID_API to your TrustID API base (e.g. https://your-trustid.netlify.app/api)",
  );
}

function redirectUri(): string {
  return (
    import.meta.env.VITE_LIFEOS_REDIRECT_URI ??
    `${window.location.origin}/callback`
  );
}

const CLIENT_ID = "lifeos_mock_public";
/** Zero-PII: ZK claims + trust level only — no email/profile/portrait. */
const SCOPES =
  "openid identity.basic identity.zk_claims identity.trust_level identity.verification_status";

function b64url(bytes: ArrayBuffer | Uint8Array) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(length = 64) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return b64url(bytes);
}

async function sha256(input: string) {
  const data = new TextEncoder().encode(input);
  return crypto.subtle.digest("SHA-256", data);
}

export async function beginTrustIdLogin() {
  const verifier = randomString(64);
  const challenge = b64url(await sha256(verifier));
  const state = randomString(24);
  const redirect = redirectUri();
  sessionStorage.setItem(
    "lifeos.oauth",
    JSON.stringify({ verifier, state, redirect }),
  );

  const url = new URL(`${trustIdApiBase()}/oauth/authorize`);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  window.location.href = url.toString();
}

export async function exchangeCode(code: string, state: string) {
  const raw = sessionStorage.getItem("lifeos.oauth");
  if (!raw) throw new Error("Missing PKCE state");
  const saved = JSON.parse(raw) as {
    verifier: string;
    state: string;
    redirect?: string;
  };
  if (saved.state !== state) throw new Error("State mismatch");

  const redirect = saved.redirect ?? redirectUri();
  const res = await fetch(`${trustIdApiBase()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: CLIENT_ID,
      code_verifier: saved.verifier,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Token exchange failed");
  sessionStorage.removeItem("lifeos.oauth");
  return data as { access_token: string; scope: string };
}

export type TrustIdUserInfo = {
  sub: string;
  trustId?: string;
  status?: string;
  zk?: { available: boolean; provePath?: string };
  trustLevel?: {
    tier: number;
    stars: number;
    maxStars: number;
    label: string;
  };
  identityStatus?: string;
  isVerifiedIdentity?: boolean;
};

export async function fetchUserInfo(accessToken: string) {
  const res = await fetch(`${trustIdApiBase()}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "userinfo failed");
  return data as TrustIdUserInfo;
}

export type ZkProofResult = {
  protocol: string;
  circuit: string;
  publicSignals: string[];
  proof: { attestation?: string; [k: string]: unknown };
  claim: {
    type: string;
    minTier: number;
    satisfied: boolean;
    nullifier: string;
  };
  trustIdNullifier: string;
  stars: number;
  maxStars: number;
  label: string;
};

/** Request a ZK trust-tier proof — no email/name/portrait. */
export async function proveTrustTier(
  accessToken: string,
  minTier = 1,
): Promise<ZkProofResult> {
  const res = await fetch(`${trustIdApiBase()}/zk/prove`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ claim: "trust_tier_gte", minTier }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || "zk prove failed");
  return data as ZkProofResult;
}

export async function verifyZkProof(proof: ZkProofResult): Promise<boolean> {
  const res = await fetch(`${trustIdApiBase()}/zk/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      proof: proof.proof,
      publicSignals: proof.publicSignals,
    }),
  });
  const data = await res.json();
  return Boolean(data.valid);
}

export type LifeOsProfile = {
  /** Pseudonymous nullifier for this RP — not the raw TrustID when ZK used */
  nullifier: string;
  trustIdHint?: string;
  stars: number;
  maxStars: number;
  trustLabel?: string;
  claimSatisfied: boolean;
  createdAt: string;
  lastLoginAt: string;
};

const PROFILE_KEY = "lifeos.localProfile";

export function upsertLifeOsProfile(input: {
  nullifier: string;
  trustIdHint?: string;
  stars: number;
  maxStars: number;
  trustLabel?: string;
  claimSatisfied: boolean;
}): LifeOsProfile {
  const existingRaw = localStorage.getItem(PROFILE_KEY);
  const existing = existingRaw ? (JSON.parse(existingRaw) as LifeOsProfile) : null;
  const profile: LifeOsProfile = {
    nullifier: input.nullifier,
    trustIdHint: input.trustIdHint,
    stars: input.stars,
    maxStars: input.maxStars,
    trustLabel: input.trustLabel,
    claimSatisfied: input.claimSatisfied,
    createdAt:
      existing?.nullifier === input.nullifier
        ? existing.createdAt
        : new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  localStorage.setItem("lifeos.session", "1");
  return profile;
}

export function getLifeOsProfile(): LifeOsProfile | null {
  const raw = localStorage.getItem(PROFILE_KEY);
  if (!raw || !localStorage.getItem("lifeos.session")) return null;
  return JSON.parse(raw) as LifeOsProfile;
}

export function clearLifeOsSession() {
  localStorage.removeItem("lifeos.session");
}

export { trustIdApiBase };
