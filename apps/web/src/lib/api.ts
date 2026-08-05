/** Same-origin `/api` (Vite proxy locally, Netlify Functions in production). */
const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(
      0,
      "Cannot reach TrustID API. If you are local, run npm run dev:api. On Netlify, wait for a fresh deploy with API functions.",
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
        "TrustID API returned a non-JSON response. Check that /api is routed to the backend.",
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
