import type { BaasResult, PrimitiveBinding } from "./types.js";

export interface ILidiosClient {
  readonly bound: boolean;
  readonly baseUrl: string | null;
  health(): Promise<BaasResult<{ ok: boolean; service?: string }>>;
}

export interface IDigiconomyClient {
  readonly bound: boolean;
  readonly baseUrl: string | null;
  health(): Promise<BaasResult<{ ok: boolean; service?: string }>>;
}

export class UnboundLidiosClient implements ILidiosClient {
  readonly bound = false;
  readonly baseUrl = null;
  async health(): Promise<BaasResult<{ ok: boolean; service?: string }>> {
    return { ok: false, error: "lidios_unbound", via: "unbound" };
  }
}

export class HttpLidiosClient implements ILidiosClient {
  readonly bound = true;
  constructor(private readonly opts: { baseUrl: string; timeoutMs?: number }) {}
  get baseUrl() {
    return this.opts.baseUrl.replace(/\/$/, "");
  }
  async health(): Promise<BaasResult<{ ok: boolean; service?: string }>> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      if (!res.ok) {
        return { ok: false, error: `LIDIOS health ${res.status}`, statusCode: res.status, via: "lidios" };
      }
      const data = (await res.json().catch(() => ({ ok: true }))) as {
        ok?: boolean;
        service?: string;
      };
      return { ok: true, data: { ok: data.ok !== false, service: data.service }, via: "lidios" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "LIDIOS unreachable",
        via: "lidios",
      };
    }
  }
}

export class UnboundDigiconomyClient implements IDigiconomyClient {
  readonly bound = false;
  readonly baseUrl = null;
  async health(): Promise<BaasResult<{ ok: boolean; service?: string }>> {
    return { ok: false, error: "digiconomy_unbound", via: "unbound" };
  }
}

export class HttpDigiconomyClient implements IDigiconomyClient {
  readonly bound = true;
  constructor(private readonly opts: { baseUrl: string; timeoutMs?: number }) {}
  get baseUrl() {
    return this.opts.baseUrl.replace(/\/$/, "");
  }
  async health(): Promise<BaasResult<{ ok: boolean; service?: string }>> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: `Digiconomy health ${res.status}`,
          statusCode: res.status,
          via: "digiconomy",
        };
      }
      const data = (await res.json().catch(() => ({ ok: true }))) as {
        ok?: boolean;
        service?: string;
      };
      return {
        ok: true,
        data: { ok: data.ok !== false, service: data.service },
        via: "digiconomy",
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Digiconomy unreachable",
        via: "digiconomy",
      };
    }
  }
}

export function summarizeBindings(input: {
  elfcom: { bound: boolean; mode: string; baseUrl: string | null };
  datazone: { bound: boolean; mode: string; baseUrl: string | null };
  finprov: { bound: boolean; mode: string; baseUrl: string | null };
  lidios: { bound: boolean; mode: string; baseUrl: string | null };
  digiconomy: { bound: boolean; mode: string; baseUrl: string | null };
}): PrimitiveBinding[] {
  return [
    {
      id: "elfcom",
      mode: input.elfcom.mode as PrimitiveBinding["mode"],
      bound: input.elfcom.bound,
      baseUrl: input.elfcom.baseUrl ?? undefined,
      role: "messaging_push_realtime",
    },
    {
      id: "datazone",
      mode: input.datazone.mode as PrimitiveBinding["mode"],
      bound: input.datazone.bound,
      baseUrl: input.datazone.baseUrl ?? undefined,
      role: "object_storage_sync_relay",
    },
    {
      id: "finprov",
      mode: input.finprov.mode as PrimitiveBinding["mode"],
      bound: input.finprov.bound,
      baseUrl: input.finprov.baseUrl ?? undefined,
      role: "payments_bbs_step_up",
    },
    {
      id: "lidios",
      mode: input.lidios.mode as PrimitiveBinding["mode"],
      bound: input.lidios.bound,
      baseUrl: input.lidios.baseUrl ?? undefined,
      role: "token_network_rp",
    },
    {
      id: "digiconomy",
      mode: input.digiconomy.mode as PrimitiveBinding["mode"],
      bound: input.digiconomy.bound,
      baseUrl: input.digiconomy.baseUrl ?? undefined,
      role: "commerce_rp",
    },
  ];
}
