/** Same-origin `/api` via Netlify proxy in production; Vite proxy locally. */
const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** @deprecated Sessions are HttpOnly cookies only — always null. */
export function getSessionToken(): string | null {
  return null;
}

/** @deprecated No-op — session is HttpOnly cookie set by the API. */
export function setSessionToken(_token: string | null) {
  /* cookie-only sessions */
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
  const method = (options.method ?? "GET").toUpperCase();
  const hasBody = options.body != null && options.body !== "";
  const body =
    hasBody
      ? options.body
      : ["POST", "PUT", "PATCH"].includes(method)
        ? "{}"
        : undefined;

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  };
  if (body != null) {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      method,
      headers,
      body,
      credentials: "include",
    });
  } catch {
    throw new ApiError(0, networkErrorMessage());
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data as { message?: string }).message ||
        (data as { error?: string }).error ||
        res.statusText,
    );
  }
  return data as T;
}
