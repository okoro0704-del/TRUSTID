export type RealtimeApprovalMessage = {
  type:
    | "approval.created"
    | "approval.state"
    | "approval.resolved"
    | "DEVICE_APPROVAL_REQUEST"
    | "MASTER_APPROVAL_REQUEST"
    | "LOGIN_APPROVAL_RESULT";
  correlationId: string;
  requestId: string;
  status: string;
  applicationName?: string;
  deviceName?: string;
  platform?: string | null;
  browser?: string | null;
  location?: string | null;
  clientId?: string | null;
  oauthConsentCodeId?: string | null;
  guestSessionId?: string | null;
  expiresAt?: string;
  createdAt?: string;
  viewedAt?: string | null;
  pushDispatchedAt?: string | null;
  pushFailedAt?: string | null;
  resolvedAt?: string | null;
  at: string;
};

export type RealtimeClientMessage =
  | { action: "ping" }
  | { action: "mark_viewed"; requestId: string };

export type RealtimeServerMessage =
  | RealtimeApprovalMessage
  | { type: "connected"; role: "master" | "guest"; at: string }
  | { type: "pong"; at: string }
  | { type: "error"; message: string };
