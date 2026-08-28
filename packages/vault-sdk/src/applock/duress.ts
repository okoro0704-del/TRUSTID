import type { DakSession } from "../crypto/dak.js";
import type {
  AppLockConfig,
  ElfComEmergencyBridge,
  EmergencyAlertPayload,
} from "../types.js";
import { AppLockRegistry } from "./registry.js";

export type DuressState = {
  active: boolean;
  decoyMode: boolean;
  lockedAt: string | null;
  correlationId: string | null;
};

export class DuressHandler {
  private state: DuressState = {
    active: false,
    decoyMode: false,
    lockedAt: null,
    correlationId: null,
  };

  constructor(
    private readonly dakSession: DakSession,
    private readonly registry: AppLockRegistry,
    private readonly elfcom?: ElfComEmergencyBridge,
  ) {}

  getState(): DuressState {
    return { ...this.state };
  }

  async handleDuress(input?: {
    correlationId?: string;
    config?: AppLockConfig;
  }): Promise<{ decoyMode: true; alertDispatched: boolean }> {
    const correlationId = input?.correlationId ?? crypto.randomUUID();
    this.dakSession.lock();
    this.state = {
      active: true,
      decoyMode: true,
      lockedAt: new Date().toISOString(),
      correlationId,
    };

    if (input?.config) {
      const locked: AppLockConfig = {
        ...input.config,
        enabled: true,
      };
      await this.registry.save(locked);
    }

    const payload: EmergencyAlertPayload = {
      type: "vault_duress",
      correlationId,
      at: new Date().toISOString(),
      note: "Duress biometric detected — vault silently locked; decoy UI active.",
    };

    let alertDispatched = false;
    if (this.elfcom) {
      const result = await this.elfcom.dispatchEmergencyAlert(payload);
      alertDispatched = result.ok;
    }

    return { decoyMode: true, alertDispatched };
  }

  reset(): void {
    this.state = {
      active: false,
      decoyMode: false,
      lockedAt: null,
      correlationId: null,
    };
  }
}

/** Default HTTP bridge for ElfCom `/consent/push` or emergency endpoint. */
export class HttpElfComEmergencyBridge implements ElfComEmergencyBridge {
  constructor(
    private readonly opts: {
      baseUrl: string;
      nodeSecret: string;
    },
  ) {}

  async dispatchEmergencyAlert(payload: EmergencyAlertPayload): Promise<{ ok: boolean }> {
    try {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/consent/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ElfCom-Node-Secret": this.opts.nodeSecret,
          "X-TrustID-Emergency": "vault_duress",
        },
        body: JSON.stringify({
          ...payload,
          silent: false,
          priority: "high",
          title: "TrustID vault duress alert",
          body: payload.note,
        }),
        signal: AbortSignal.timeout(8000),
      });
      return { ok: res.ok };
    } catch {
      return { ok: false };
    }
  }
}
