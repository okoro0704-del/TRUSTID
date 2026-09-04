/** Shared result shape for outbound BaaS calls. */
export type BaasResult<T = void> = {
  ok: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
  /** Which primitive handled the call */
  via:
    | "elfcom"
    | "datazone"
    | "finprov"
    | "platform_job"
    | "master_distribution"
    | "lidios"
    | "digiconomy"
    | "unbound"
    | "local_fallback";
};

export type PrimitiveMode = "unbound" | "http" | "embedded";

export type PrimitiveBinding = {
  id:
    | "elfcom"
    | "datazone"
    | "finprov"
    | "platform_job"
    | "master_distribution"
    | "lidios"
    | "digiconomy";
  mode: PrimitiveMode;
  bound: boolean;
  baseUrl?: string;
  role: string;
};
