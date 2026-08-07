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

function networkErrorMessage(): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "You're offline. Connect to the internet and try again.";
  }
  return "Can't reach TrustID right now. Check your connection and try again.";
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
    throw new ApiError(0, networkErrorMessage());
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
          res.status >= 500
            ? "TrustID is temporarily unavailable. Please try again in a moment."
            : `Something went wrong (${res.status}). Please try again.`,
        );
      }
      throw new ApiError(
        res.status,
        "Unexpected response from TrustID. Please try again.",
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
