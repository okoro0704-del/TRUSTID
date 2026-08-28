export type ConsentPushPayload = {
  correlationId: string;
  requestId: string;
  ownerTrustId: string;
  title: string;
  body: string;
  silent: boolean;
  deepLink?: string;
  metadata?: Record<string, unknown>;
};

export type ConsentPushResult = {
  ok: boolean;
  error?: string;
  statusCode?: number;
};

export interface IElfComConsentDispatcher {
  readonly bound: boolean;
  pushConsent(payload: ConsentPushPayload): Promise<ConsentPushResult>;
}

export class UnboundElfComConsentDispatcher implements IElfComConsentDispatcher {
  readonly bound = false;

  async pushConsent(): Promise<ConsentPushResult> {
    return { ok: false, error: "elfcom_unbound" };
  }
}

export class HttpElfComConsentDispatcher implements IElfComConsentDispatcher {
  readonly bound = true;

  constructor(
    private readonly opts: {
      baseUrl: string;
      nodeSecret: string;
      timeoutMs?: number;
    },
  ) {}

  async pushConsent(payload: ConsentPushPayload): Promise<ConsentPushResult> {
    try {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/consent/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ElfCom-Node-Secret": this.opts.nodeSecret,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          ok: false,
          error: text || `ElfCom push failed (${res.status})`,
          statusCode: res.status,
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "ElfCom unreachable",
      };
    }
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
