import type {
  ElfComConsentPushPayload,
  IElfComClient,
} from "@trustid/baas-sdk";
import { getElfComClient } from "../baas/registry.js";

export type ConsentPushPayload = ElfComConsentPushPayload;

export type ConsentPushResult = {
  ok: boolean;
  error?: string;
  statusCode?: number;
};

export interface IElfComConsentDispatcher {
  readonly bound: boolean;
  pushConsent(payload: ConsentPushPayload): Promise<ConsentPushResult>;
}

/** @deprecated Prefer getElfComClient() from baas registry. */
export class UnboundElfComConsentDispatcher implements IElfComConsentDispatcher {
  readonly bound = false;

  async pushConsent(): Promise<ConsentPushResult> {
    return { ok: false, error: "elfcom_unbound" };
  }
}

/**
 * Thin adapter over @trustid/baas-sdk ElfCom client.
 * TrustID must not own FCM / inbox — ElfCom does.
 */
export class HttpElfComConsentDispatcher implements IElfComConsentDispatcher {
  readonly bound = true;

  constructor(
    private readonly opts: {
      baseUrl: string;
      nodeSecret: string;
      timeoutMs?: number;
    },
  ) {
    void this.opts;
  }

  async pushConsent(payload: ConsentPushPayload): Promise<ConsentPushResult> {
    const client: IElfComClient = getElfComClient();
    const result = await client.pushConsent(payload);
    return {
      ok: result.ok,
      error: result.error,
      statusCode: result.statusCode,
    };
  }
}

/** In-memory test double — records pushes and simulates success/failure. */
export class MockElfComConsentDispatcher implements IElfComConsentDispatcher {
  readonly bound = true;
  pushes: ConsentPushPayload[] = [];
  shouldFail = false;
  failError = "push_delivery_failed";

  async pushConsent(payload: ConsentPushPayload): Promise<ConsentPushResult> {
    this.pushes.push(payload);
    if (this.shouldFail) {
      return { ok: false, error: this.failError };
    }
    return { ok: true };
  }

  reset() {
    this.pushes = [];
    this.shouldFail = false;
  }
}

let dispatcher: IElfComConsentDispatcher = new UnboundElfComConsentDispatcher();

export function getElfComConsentDispatcher() {
  return dispatcher;
}

export function setElfComConsentDispatcher(next: IElfComConsentDispatcher) {
  dispatcher = next;
}

export function resetElfComConsentDispatcher() {
  dispatcher = new UnboundElfComConsentDispatcher();
}
