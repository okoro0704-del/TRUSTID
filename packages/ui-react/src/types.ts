export type TrustIdIdentity = {
  trustId: string;
  status: string;
  profile: { firstName: string; lastName: string; name: string } | null;
  contacts: { type: string; value: string; verified: boolean }[];
  identityVerification?: {
    status: string;
    provider: string | null;
    method: string | null;
    verifiedAt: string | null;
  };
};

export type RealtimeConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "unsupported";

export type DeviceApprovalEvent = {
  type: "approval_created" | "approval_updated";
  requestId: string;
  status: string;
  deviceName?: string;
  at: string;
};

export type TrustIdAuthContextValue = {
  loading: boolean;
  identity: TrustIdIdentity | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setIdentity: (identity: TrustIdIdentity | null) => void;
  apiBaseUrl: string;
  apiFetch: <T>(path: string, init?: RequestInit) => Promise<T>;
  realtimeState: RealtimeConnectionState;
  approvalEvents: DeviceApprovalEvent[];
  clearApprovalEvents: () => void;
};
