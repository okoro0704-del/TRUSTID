import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createTrustIdApiClient,
  resolveRealtimeUrl,
  type TrustIdApiClient,
} from "../api/client.js";
import { clearStaleAuthCaches } from "../lib/silentAuth.js";
import type {
  DeviceApprovalEvent,
  RealtimeConnectionState,
  TrustIdAuthContextValue,
  TrustIdIdentity,
} from "../types.js";

const TrustIdAuthContext = createContext<TrustIdAuthContextValue | null>(null);

export type TrustIdAuthProviderProps = {
  children: ReactNode;
  /** API prefix, e.g. `/api` or full URL. */
  apiBaseUrl?: string;
  credentials?: RequestCredentials;
  /** Connect WebSocket for cross-device approval events when signed in. */
  enableRealtime?: boolean;
  /** Called after session refresh succeeds. */
  onIdentityChange?: (identity: TrustIdIdentity | null) => void;
  /** Inject API client (testing). */
  apiClient?: TrustIdApiClient;
};

export function TrustIdAuthProvider({
  children,
  apiBaseUrl = "/api",
  credentials = "include",
  enableRealtime = true,
  onIdentityChange,
  apiClient: apiClientProp,
}: TrustIdAuthProviderProps) {
  const apiClient = useMemo(
    () => apiClientProp ?? createTrustIdApiClient({ baseUrl: apiBaseUrl, credentials }),
    [apiClientProp, apiBaseUrl, credentials],
  );

  const [loading, setLoading] = useState(true);
  const [identity, setIdentityState] = useState<TrustIdIdentity | null>(null);
  const [realtimeState, setRealtimeState] =
    useState<RealtimeConnectionState>("idle");
  const [approvalEvents, setApprovalEvents] = useState<DeviceApprovalEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setIdentity = useCallback(
    (next: TrustIdIdentity | null) => {
      setIdentityState(next);
      onIdentityChange?.(next);
    },
    [onIdentityChange],
  );

  const refresh = useCallback(async () => {
    try {
      const data = await apiClient.fetch<{ identity: TrustIdIdentity }>(
        "/auth/session",
        { method: "POST" },
      );
      setIdentity(data.identity);
    } catch {
      setIdentity(null);
    }
  }, [apiClient, setIdentity]);

  const clearApprovalEvents = useCallback(() => {
    setApprovalEvents([]);
  }, []);

  const logout = useCallback(async () => {
    // Instant facial-free logout: clear local session state first, revoke in background.
    setIdentity(null);
    clearApprovalEvents();
    try {
      clearStaleAuthCaches();
    } catch {
      /* ignore */
    }
    void apiClient.fetch("/auth/logout", { method: "POST" }).catch(() => {
      /* background revoke — local clear already done */
    });
  }, [apiClient, clearApprovalEvents, setIdentity]);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    if (!enableRealtime || !identity || typeof WebSocket === "undefined") {
      setRealtimeState(enableRealtime ? "idle" : "unsupported");
      return;
    }

    let cancelled = false;

    function connect() {
      if (cancelled) return;
      setRealtimeState("connecting");
      const url = resolveRealtimeUrl(apiClient.getBaseUrl());
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setRealtimeState("connected");
        ws.send(JSON.stringify({ action: "ping" }));
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (msg.type === "pong" || msg.type === "connected") return;

          const rawType = String(msg.type ?? "");
          const normalized =
            rawType === "approval.created" ||
            rawType === "DEVICE_APPROVAL_REQUEST" ||
            rawType === "MASTER_APPROVAL_REQUEST"
              ? ("approval_created" as const)
              : rawType === "approval.state" || rawType === "approval_updated"
                ? ("approval_updated" as const)
                : rawType === "approval.resolved" || rawType === "LOGIN_APPROVAL_RESULT"
                  ? ("approval_resolved" as const)
                  : null;

          if (
            !normalized &&
            rawType !== "DEVICE_APPROVAL_REQUEST" &&
            rawType !== "MASTER_APPROVAL_REQUEST"
          ) {
            return;
          }

          const event: DeviceApprovalEvent = {
            type:
              rawType === "MASTER_APPROVAL_REQUEST"
                ? "MASTER_APPROVAL_REQUEST"
                : rawType === "DEVICE_APPROVAL_REQUEST"
                  ? "DEVICE_APPROVAL_REQUEST"
                  : rawType === "LOGIN_APPROVAL_RESULT"
                    ? "LOGIN_APPROVAL_RESULT"
                    : (normalized as DeviceApprovalEvent["type"]),
            requestId: String(msg.requestId ?? ""),
            status: String(msg.status ?? "pending"),
            deviceName:
              typeof msg.deviceName === "string" ? msg.deviceName : undefined,
            applicationName:
              typeof msg.applicationName === "string"
                ? msg.applicationName
                : undefined,
            ipAddress:
              typeof msg.ip === "string"
                ? msg.ip
                : typeof msg.ipAddress === "string"
                  ? msg.ipAddress
                  : undefined,
            at: String(msg.at ?? new Date().toISOString()),
          };
          if (!event.requestId) return;
          setApprovalEvents((prev) => [event, ...prev].slice(0, 50));
        } catch {
          /* ignore malformed frames */
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setRealtimeState("disconnected");
        reconnectTimer.current = setTimeout(connect, 4000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [enableRealtime, identity, apiClient]);

  const apiFetch = useCallback(
    <T,>(path: string, init?: RequestInit) => apiClient.fetch<T>(path, init),
    [apiClient],
  );

  const value: TrustIdAuthContextValue = {
    loading,
    identity,
    refresh,
    logout,
    setIdentity,
    apiBaseUrl: apiClient.getBaseUrl(),
    apiFetch,
    realtimeState,
    approvalEvents,
    clearApprovalEvents,
  };

  return (
    <TrustIdAuthContext.Provider value={value}>
      {children}
    </TrustIdAuthContext.Provider>
  );
}

export function useTrustIdAuth(): TrustIdAuthContextValue {
  const ctx = useContext(TrustIdAuthContext);
  if (!ctx) {
    throw new Error("useTrustIdAuth requires TrustIdAuthProvider");
  }
  return ctx;
}

/** Alias for apps migrating from legacy `useAuth`. */
export const useAuth = useTrustIdAuth;
