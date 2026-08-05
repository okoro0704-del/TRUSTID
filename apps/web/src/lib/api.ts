/** Same-origin `/api` via Netlify proxy in production; Vite proxy locally. */
const API_BASE = import.meta.env.VITE_API_URL ?? "/api";
const SESSION_KEY = "trustid.sessionToken";
const SESSION_COOKIE = "trustid_session";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function getSessionToken(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function writeSessionCookie(token: string | null) {
  try {
    if (token) {
      // First-party cookie on the TrustID Netlify host so /api proxy forwards it to Railway
      const maxAge = 60 * 60 * 24 * 7;
      document.cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Secure; SameSite=Lax; Max-Age=${maxAge}`;
    } else {
      document.cookie = `${SESSION_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;
    }
  } catch {
    /* ignore */
  }
}

export function setSessionToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(SESSION_KEY, token);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  writeSessionCookie(token);
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  const token = getSessionToken();
  if (token && !headers.Authorization && !headers["X-TrustID-Session"]) {
    // Netlify proxies often strip Authorization — send custom header + rely on Cookie
    headers["X-TrustID-Session"] = token;
    headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: "include",
      headers,
    });
  } catch {
    throw new ApiError(
      0,
      "Cannot reach TrustID API. Check that Netlify /api proxy and Railway API are online.",
    );
  }

  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (!res.ok) {
        throw new ApiError(
          res.status,
          `TrustID API error (${res.status}). The API may not be deployed.`,
        );
      }
      throw new ApiError(
        res.status,
        "TrustID API returned a non-JSON response.",
      );
    }
  }

  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(data.message || data.error || `Request failed (${res.status})`),
    );
  }
  return data as T;
}
