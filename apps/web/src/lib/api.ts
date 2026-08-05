/** Same-origin `/api` via Netlify proxy in production; Vite proxy locally. */
const API_BASE = import.meta.env.VITE_API_URL ?? "/api";
const SESSION_KEY = "trustid.sessionToken";

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

export function setSessionToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(SESSION_KEY, token);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
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
  if (token && !headers.Authorization) {
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
