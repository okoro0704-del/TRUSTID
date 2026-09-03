export class TrustIdApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type TrustIdApiClient = {
  getBaseUrl(): string;
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
};

export type TrustIdApiClientOptions = {
  baseUrl?: string;
  credentials?: RequestCredentials;
};

function networkErrorMessage(): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "You're offline. Connect to the internet and try again.";
  }
  return "Can't reach TrustID right now. Check your connection and try again.";
}

export function createTrustIdApiClient(
  opts: TrustIdApiClientOptions = {},
): TrustIdApiClient {
  const baseUrl = opts.baseUrl ?? "/api";
  const credentials = opts.credentials ?? "include";

  async function fetchApi<T>(path: string, options: RequestInit = {}): Promise<T> {
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
      res = await fetch(`${baseUrl}${path}`, {
        ...options,
        method,
        headers,
        body,
        credentials,
      });
    } catch {
      throw new TrustIdApiError(0, networkErrorMessage());
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new TrustIdApiError(
        res.status,
        (data as { message?: string }).message ||
          (data as { error?: string }).error ||
          res.statusText,
      );
    }
    return data as T;
  }

  return {
    getBaseUrl: () => baseUrl,
    fetch: fetchApi,
  };
}

export function resolveRealtimeUrl(apiBaseUrl: string): string {
  if (typeof window === "undefined") {
    return `${apiBaseUrl.replace(/\/$/, "")}/realtime/approvals`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (apiBaseUrl.startsWith("http://") || apiBaseUrl.startsWith("https://")) {
    const url = new URL(apiBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${url.origin}${url.pathname.replace(/\/$/, "")}/realtime/approvals`;
  }
  const path = apiBaseUrl.replace(/\/$/, "");
  return `${protocol}//${window.location.host}${path}/realtime/approvals`;
}

/** Guest/secondary device WebSocket while waiting for master approval. */
export function resolveGuestRealtimeUrl(
  apiBaseUrl: string,
  pollToken: string,
): string {
  const base = resolveRealtimeUrl(apiBaseUrl).replace(/\/$/, "");
  return `${base}/guest?pollToken=${encodeURIComponent(pollToken)}`;
}
