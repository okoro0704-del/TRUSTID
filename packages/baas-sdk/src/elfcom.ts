import type { BaasResult } from "./types.js";

export type ElfComConsentPushPayload = {
  correlationId: string;
  requestId: string;
  ownerTrustId: string;
  title: string;
  body: string;
  silent: boolean;
  deepLink?: string;
  metadata?: Record<string, unknown>;
};

export type ElfComPushTokenInput = {
  ownerTrustId: string;
  token: string;
  platform?: string;
  deviceId?: string | null;
  channelId?: string;
};

export type ElfComNotification = {
  id: string;
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

export interface IElfComClient {
  readonly bound: boolean;
  readonly baseUrl: string | null;
  readonly realtimeUrl: string | null;
  pushConsent(payload: ElfComConsentPushPayload): Promise<BaasResult>;
  registerPushToken(input: ElfComPushTokenInput): Promise<BaasResult<{ id?: string }>>;
  listNotifications(ownerTrustId: string): Promise<BaasResult<{ items: ElfComNotification[]; unread: number }>>;
  markNotificationRead(ownerTrustId: string, id: string): Promise<BaasResult>;
}

const PUSH_PATHS = [
  "/consent/push",
  "/v1/consent/push",
  "/omnichannel/push",
  "/messaging/push",
  "/trustid/consent/push",
];

export class UnboundElfComClient implements IElfComClient {
  readonly bound = false;
  readonly baseUrl = null;
  readonly realtimeUrl = null;

  async pushConsent(): Promise<BaasResult> {
    return { ok: false, error: "elfcom_unbound", via: "unbound" };
  }
  async registerPushToken(): Promise<BaasResult<{ id?: string }>> {
    return { ok: false, error: "elfcom_unbound", via: "unbound" };
  }
  async listNotifications(): Promise<BaasResult<{ items: ElfComNotification[]; unread: number }>> {
    return { ok: false, error: "elfcom_unbound", via: "unbound" };
  }
  async markNotificationRead(): Promise<BaasResult> {
    return { ok: false, error: "elfcom_unbound", via: "unbound" };
  }
}

/**
 * HTTP consumer for ElfCom messaging / consent / push.
 * Tries known push paths so TrustID does not own FCM or inbox storage.
 */
export class HttpElfComClient implements IElfComClient {
  readonly bound = true;

  constructor(
    private readonly opts: {
      baseUrl: string;
      nodeSecret: string;
      timeoutMs?: number;
      realtimePath?: string;
    },
  ) {}

  get baseUrl() {
    return this.opts.baseUrl.replace(/\/$/, "");
  }

  get realtimeUrl() {
    const base = this.baseUrl.replace(/^http/, "ws");
    return `${base}${this.opts.realtimePath ?? "/realtime/trustid"}`;
  }

  private headers(extra?: Record<string, string>) {
    return {
      "Content-Type": "application/json",
      "X-ElfCom-Node-Secret": this.opts.nodeSecret,
      ...extra,
    };
  }

  async pushConsent(payload: ElfComConsentPushPayload): Promise<BaasResult> {
    let lastError = "ElfCom push failed";
    let lastStatus: number | undefined;
    for (const path of PUSH_PATHS) {
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
        });
        if (res.ok) return { ok: true, via: "elfcom", statusCode: res.status };
        lastStatus = res.status;
        lastError = (await res.text().catch(() => "")) || `ElfCom push failed (${res.status})`;
        if (res.status !== 404) break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : "ElfCom unreachable";
      }
    }
    return { ok: false, error: lastError, statusCode: lastStatus, via: "elfcom" };
  }

  async registerPushToken(input: ElfComPushTokenInput): Promise<BaasResult<{ id?: string }>> {
    try {
      const res = await fetch(`${this.baseUrl}/devices/push-token`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          ok: false,
          error: text || `ElfCom token register failed (${res.status})`,
          statusCode: res.status,
          via: "elfcom",
        };
      }
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      return { ok: true, data, via: "elfcom" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "ElfCom unreachable",
        via: "elfcom",
      };
    }
  }

  async listNotifications(
    ownerTrustId: string,
  ): Promise<BaasResult<{ items: ElfComNotification[]; unread: number }>> {
    try {
      const url = new URL(`${this.baseUrl}/notifications`);
      url.searchParams.set("ownerTrustId", ownerTrustId);
      const res = await fetch(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: `ElfCom notifications failed (${res.status})`,
          statusCode: res.status,
          via: "elfcom",
        };
      }
      const data = (await res.json()) as { items?: ElfComNotification[]; unread?: number };
      return {
        ok: true,
        data: { items: data.items ?? [], unread: data.unread ?? 0 },
        via: "elfcom",
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "ElfCom unreachable",
        via: "elfcom",
      };
    }
  }

  async markNotificationRead(ownerTrustId: string, id: string): Promise<BaasResult> {
    try {
      const res = await fetch(`${this.baseUrl}/notifications/${encodeURIComponent(id)}/read`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ ownerTrustId }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: `ElfCom mark-read failed (${res.status})`,
          statusCode: res.status,
          via: "elfcom",
        };
      }
      return { ok: true, via: "elfcom" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "ElfCom unreachable",
        via: "elfcom",
      };
    }
  }
}
