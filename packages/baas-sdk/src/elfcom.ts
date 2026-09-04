import type { BaasResult } from "./types.js";

export const ELFCOM_TRUST_ID_APP_ID = "trust_id_app";
export const ELFCOM_SECURITY_CHANNEL = "trust_id_security_alerts";

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
  /** Capability / TrustID JWT — required by POST /v1/devices/register */
  bearerToken: string;
  appId?: string;
};

export type ElfComBaasNotifyInput = {
  targetTrustId: string;
  title?: string;
  body?: string;
  priority?: "NORMAL" | "HIGH" | "MAX";
  channelId?: string;
  appId?: string;
  dataPayload?: Record<string, unknown>;
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
  /** Master approval / consent heads-up via POST /v1/baas/notify */
  pushConsent(payload: ElfComConsentPushPayload): Promise<BaasResult>;
  /** Direct BaaS notify (preferred for master device approval) */
  notify(input: ElfComBaasNotifyInput): Promise<BaasResult<{ jobId?: string; dispatchedToCount?: number }>>;
  registerPushToken(input: ElfComPushTokenInput): Promise<BaasResult<{ id?: string }>>;
  listNotifications(ownerTrustId: string): Promise<BaasResult<{ items: ElfComNotification[]; unread: number }>>;
  markNotificationRead(ownerTrustId: string, id: string): Promise<BaasResult>;
}

export class UnboundElfComClient implements IElfComClient {
  readonly bound = false;
  readonly baseUrl = null;
  readonly realtimeUrl = null;

  async pushConsent(): Promise<BaasResult> {
    return { ok: false, error: "elfcom_unbound", via: "unbound" };
  }
  async notify(): Promise<BaasResult<{ jobId?: string; dispatchedToCount?: number }>> {
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

function normalizePlatform(platform?: string): "ANDROID" | "IOS" | "WEB" {
  const p = (platform ?? "android").toLowerCase();
  if (p === "ios" || p === "iphone" || p === "ipad") return "IOS";
  if (p === "web" || p === "browser") return "WEB";
  return "ANDROID";
}

/**
 * HTTP consumer for ElfCom Universal Push Primitive (phase E / notify pillar).
 * - Device register: POST /v1/devices/register (user capability JWT)
 * - Heads-up notify: POST /v1/baas/notify (BaaS API key)
 */
export class HttpElfComClient implements IElfComClient {
  readonly bound = true;

  constructor(
    private readonly opts: {
      baseUrl: string;
      nodeSecret?: string;
      /** Maps to trust_id_app in ELFCOM_BAAS_API_KEYS */
      baasApiKey?: string;
      appId?: string;
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

  private get appId() {
    return this.opts.appId ?? ELFCOM_TRUST_ID_APP_ID;
  }

  private baasHeaders(extra?: Record<string, string>) {
    const key = this.opts.baasApiKey?.trim();
    if (!key) {
      throw new Error("ELFCOM_BAAS_API_KEY is not configured");
    }
    return {
      "Content-Type": "application/json",
      "X-ElfCom-Api-Key": key,
      ...extra,
    };
  }

  async notify(
    input: ElfComBaasNotifyInput,
  ): Promise<BaasResult<{ jobId?: string; dispatchedToCount?: number }>> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/baas/notify`, {
        method: "POST",
        headers: this.baasHeaders(),
        body: JSON.stringify({
          targetTrustId: input.targetTrustId,
          appId: input.appId ?? this.appId,
          title: input.title,
          body: input.body,
          priority: input.priority ?? "MAX",
          channelId: input.channelId ?? ELFCOM_SECURITY_CHANNEL,
          dataPayload: input.dataPayload,
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          ok: false,
          error: text || `ElfCom notify failed (${res.status})`,
          statusCode: res.status,
          via: "elfcom",
        };
      }
      const data = (await res.json().catch(() => ({}))) as {
        jobId?: string;
        dispatchedToCount?: number;
      };
      return { ok: true, data, via: "elfcom", statusCode: res.status };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "ElfCom unreachable",
        via: "elfcom",
      };
    }
  }

  async pushConsent(payload: ElfComConsentPushPayload): Promise<BaasResult> {
    if (!this.opts.baasApiKey?.trim()) {
      return {
        ok: false,
        error: "ELFCOM_BAAS_API_KEY is not configured",
        via: "elfcom",
      };
    }

    const meta = payload.metadata ?? {};
    const challengeId =
      (typeof meta.requestId === "string" && meta.requestId) ||
      (typeof meta.challengeId === "string" && meta.challengeId) ||
      payload.requestId;

    const result = await this.notify({
      targetTrustId: payload.ownerTrustId,
      title: payload.title || "Master Device Approval Required",
      body: payload.body,
      priority: payload.silent ? "NORMAL" : "MAX",
      channelId:
        (typeof meta.channelId === "string" && meta.channelId) ||
        ELFCOM_SECURITY_CHANNEL,
      dataPayload: {
        type: "master_device_approval",
        challengeId,
        requestId: payload.requestId,
        correlationId: payload.correlationId,
        deepLink:
          payload.deepLink ?? `trustid://approvals/${challengeId}`,
        ...meta,
      },
    });
    return {
      ok: result.ok,
      error: result.error,
      statusCode: result.statusCode,
      via: result.via,
    };
  }

  async registerPushToken(input: ElfComPushTokenInput): Promise<BaasResult<{ id?: string }>> {
    if (!input.bearerToken?.trim()) {
      return {
        ok: false,
        error: "ElfCom device register requires a capability JWT",
        via: "elfcom",
      };
    }
    try {
      const res = await fetch(`${this.baseUrl}/v1/devices/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.bearerToken}`,
        },
        body: JSON.stringify({
          trustId: input.ownerTrustId,
          appId: input.appId ?? this.appId,
          platform: normalizePlatform(input.platform),
          pushToken: input.token,
          deviceId: input.deviceId?.trim() || `trustid-${input.ownerTrustId.slice(0, 12)}`,
        }),
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
      const body = (await res.json().catch(() => ({}))) as {
        token?: { id?: string };
        id?: string;
      };
      return {
        ok: true,
        data: { id: body.token?.id ?? body.id },
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

  async listNotifications(
    ownerTrustId: string,
  ): Promise<BaasResult<{ items: ElfComNotification[]; unread: number }>> {
    try {
      const url = new URL(`${this.baseUrl}/notifications`);
      url.searchParams.set("ownerTrustId", ownerTrustId);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.opts.baasApiKey?.trim()) {
        headers["X-ElfCom-Api-Key"] = this.opts.baasApiKey.trim();
      } else if (this.opts.nodeSecret) {
        headers["X-ElfCom-Node-Secret"] = this.opts.nodeSecret;
      }
      const res = await fetch(url, {
        headers,
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
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.opts.baasApiKey?.trim()) {
        headers["X-ElfCom-Api-Key"] = this.opts.baasApiKey.trim();
      } else if (this.opts.nodeSecret) {
        headers["X-ElfCom-Node-Secret"] = this.opts.nodeSecret;
      }
      const res = await fetch(`${this.baseUrl}/notifications/${encodeURIComponent(id)}/read`, {
        method: "POST",
        headers,
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
