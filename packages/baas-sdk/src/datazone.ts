import { createHmac } from "node:crypto";
import type { BaasResult } from "./types.js";

export type DataZonePutInput = {
  userId: string;
  trustId: string;
  purpose: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type DataZoneObject = {
  storageKey: string;
  contentHash: string;
  byteSize: number;
  downloadUrl?: string;
};

export type DataZoneEnvelopeInput = {
  userId: string;
  trustId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  envelopeType: string;
  header: Record<string, unknown>;
  nonce: string;
  ciphertext: string;
  ttlHours?: number;
};

export interface IDataZoneClient {
  readonly bound: boolean;
  readonly baseUrl: string | null;
  putObject(input: DataZonePutInput): Promise<BaasResult<DataZoneObject>>;
  getObjectBytes(storageKey: string, auth: { userId: string; trustId: string }): Promise<BaasResult<Uint8Array>>;
  queueEnvelope(input: DataZoneEnvelopeInput): Promise<BaasResult<{ id: string }>>;
  listInbox(input: {
    userId: string;
    trustId: string;
    recipientDeviceId: string;
  }): Promise<BaasResult<{ envelopes: unknown[] }>>;
}

export class UnboundDataZoneClient implements IDataZoneClient {
  readonly bound = false;
  readonly baseUrl = null;

  async putObject(): Promise<BaasResult<DataZoneObject>> {
    return { ok: false, error: "datazone_unbound", via: "unbound" };
  }
  async getObjectBytes(): Promise<BaasResult<Uint8Array>> {
    return { ok: false, error: "datazone_unbound", via: "unbound" };
  }
  async queueEnvelope(): Promise<BaasResult<{ id: string }>> {
    return { ok: false, error: "datazone_unbound", via: "unbound" };
  }
  async listInbox(): Promise<BaasResult<{ envelopes: unknown[] }>> {
    return { ok: false, error: "datazone_unbound", via: "unbound" };
  }
}

function b64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

/** Mint HS256 TrustID?DataZone service JWT (sub + tid required by sovereign-drive). */
export function mintDataZoneServiceJwt(input: {
  secret: string;
  issuer: string;
  audience: string;
  userId: string;
  trustId: string;
  ttlSeconds?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: input.issuer,
      aud: input.audience,
      sub: input.userId,
      tid: input.trustId,
      iat: now,
      exp: now + (input.ttlSeconds ?? 3600),
    }),
  );
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", input.secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/**
 * HTTP consumer for DataZone sovereign-drive / object storage.
 * TrustID keeps portrait metadata only; bytes live in DataZone.
 */
export class HttpDataZoneClient implements IDataZoneClient {
  readonly bound = true;

  constructor(
    private readonly opts: {
      baseUrl: string;
      jwtSecret: string;
      issuer?: string;
      audience?: string;
      timeoutMs?: number;
      putPath?: string;
      getPathPrefix?: string;
      envelopePath?: string;
      inboxPathPrefix?: string;
    },
  ) {}

  get baseUrl() {
    return this.opts.baseUrl.replace(/\/$/, "");
  }

  private token(userId: string, trustId: string) {
    return mintDataZoneServiceJwt({
      secret: this.opts.jwtSecret,
      issuer: this.opts.issuer ?? "https://trustedid.netlify.app",
      audience: this.opts.audience ?? "data-zone",
      userId,
      trustId,
    });
  }

  async putObject(input: DataZonePutInput): Promise<BaasResult<DataZoneObject>> {
    const path = this.opts.putPath ?? "/objects";
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token(input.userId, input.trustId)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          purpose: input.purpose,
          mimeType: input.mimeType,
          bytesBase64: Buffer.from(input.bytes).toString("base64"),
          trustId: input.trustId,
          userId: input.userId,
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          ok: false,
          error: text || `DataZone put failed (${res.status})`,
          statusCode: res.status,
          via: "datazone",
        };
      }
      const data = (await res.json()) as DataZoneObject;
      return { ok: true, data, via: "datazone" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "DataZone unreachable",
        via: "datazone",
      };
    }
  }

  async getObjectBytes(
    storageKey: string,
    auth: { userId: string; trustId: string },
  ): Promise<BaasResult<Uint8Array>> {
    const prefix = this.opts.getPathPrefix ?? "/objects";
    try {
      const res = await fetch(
        `${this.baseUrl}${prefix}/${encodeURIComponent(storageKey)}`,
        {
          headers: {
            Authorization: `Bearer ${this.token(auth.userId, auth.trustId)}`,
          },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15000),
        },
      );
      if (!res.ok) {
        return {
          ok: false,
          error: `DataZone get failed (${res.status})`,
          statusCode: res.status,
          via: "datazone",
        };
      }
      const ctype = res.headers.get("content-type") ?? "";
      if (ctype.includes("application/json")) {
        const json = (await res.json()) as { bytesBase64?: string };
        if (!json.bytesBase64) {
          return { ok: false, error: "DataZone object missing bytes", via: "datazone" };
        }
        return {
          ok: true,
          data: new Uint8Array(Buffer.from(json.bytesBase64, "base64")),
          via: "datazone",
        };
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      return { ok: true, data: buf, via: "datazone" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "DataZone unreachable",
        via: "datazone",
      };
    }
  }

  async queueEnvelope(input: DataZoneEnvelopeInput): Promise<BaasResult<{ id: string }>> {
    const path = this.opts.envelopePath ?? "/sync/envelopes";
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token(input.userId, input.trustId)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10000),
      });
      if (!res.ok) {
        return {
          ok: false,
          error: `DataZone envelope failed (${res.status})`,
          statusCode: res.status,
          via: "datazone",
        };
      }
      const data = (await res.json()) as { id: string };
      return { ok: true, data, via: "datazone" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "DataZone unreachable",
        via: "datazone",
      };
    }
  }

  async listInbox(input: {
    userId: string;
    trustId: string;
    recipientDeviceId: string;
  }): Promise<BaasResult<{ envelopes: unknown[] }>> {
    const prefix = this.opts.inboxPathPrefix ?? "/sync/inbox";
    try {
      const res = await fetch(
        `${this.baseUrl}${prefix}/${encodeURIComponent(input.recipientDeviceId)}`,
        {
          headers: {
            Authorization: `Bearer ${this.token(input.userId, input.trustId)}`,
          },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10000),
        },
      );
      if (!res.ok) {
        return {
          ok: false,
          error: `DataZone inbox failed (${res.status})`,
          statusCode: res.status,
          via: "datazone",
        };
      }
      const data = (await res.json()) as { envelopes?: unknown[] };
      return { ok: true, data: { envelopes: data.envelopes ?? [] }, via: "datazone" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "DataZone unreachable",
        via: "datazone",
      };
    }
  }
}
