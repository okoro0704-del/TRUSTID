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
  // Production LifeOS must set VITE_TRUSTID_API to the TrustID site /api URL
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
/** Include trust_level + portrait so Life OS shows the same stars / verified photo. */
const SCOPES =
  "openid identity.basic identity.profile identity.email identity.verification_status identity.trust_level identity.portrait";

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
  trustId: string;
  status?: string;
  profile?: { firstName: string; lastName: string; name: string };
  contacts?: { type: string; value: string }[];
  trustLevel?: {
    tier: number;
    stars: number;
    maxStars: number;
    label: string;
  };
  hasVerifiedIdentityPortrait?: boolean;
  portraitRef?: string | null;
  portraitVersion?: number;
};

export async function fetchUserInfo(accessToken: string) {
  const res = await fetch(`${trustIdApiBase()}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "userinfo failed");
  return data as TrustIdUserInfo;
}

export async function fetchVerifiedPortrait(accessToken: string) {
  const res = await fetch(`${trustIdApiBase()}/identity/portrait`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  const data = await res.json();
  if (!res.ok) return null;
  const media = data.mediaAccess as
    | { path: string; token: string; expiresAt: string }
    | undefined;
  if (!media) return null;
  return {
    url: `${trustIdApiBase()}${media.path}?token=${encodeURIComponent(media.token)}`,
    expiresAt: media.expiresAt,
  };
}

export type LifeOsProfile = {
  trustId: string;
  displayName: string;
  email?: string;
  stars: number;
  maxStars: number;
  trustLabel?: string;
  hasVerifiedPortrait: boolean;
  createdAt: string;
  lastLoginAt: string;
};

const PROFILE_KEY = "lifeos.localProfile";

export function upsertLifeOsProfile(identity: TrustIdUserInfo): LifeOsProfile {
  const existingRaw = localStorage.getItem(PROFILE_KEY);
  const existing = existingRaw ? (JSON.parse(existingRaw) as LifeOsProfile) : null;
  const email = identity.contacts?.find((c) => c.type === "email")?.value;
  const stars = identity.trustLevel?.stars ?? identity.trustLevel?.tier ?? 0;
  const maxStars = identity.trustLevel?.maxStars ?? 3;
  const profile: LifeOsProfile = {
    trustId: identity.trustId ?? identity.sub,
    displayName: identity.profile?.name ?? identity.trustId ?? identity.sub,
    email,
    stars,
    maxStars,
    trustLabel: identity.trustLevel?.label,
    hasVerifiedPortrait: Boolean(identity.hasVerifiedIdentityPortrait),
    createdAt:
      existing?.trustId === (identity.trustId ?? identity.sub)
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
