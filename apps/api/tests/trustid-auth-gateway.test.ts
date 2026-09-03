import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { trustIdAuthRoutes } from "../../../services/gateway/src/routes/trustIdAuth.js";

function face512() {
  return Array.from({ length: 512 }, (_, i) => ((i % 23) + 1) / 1000);
}

function makeApp(script: {
  identityDistance: number | null;
  knownDevice: boolean;
}) {
  const app = Fastify();
  const calls: string[] = [];

  const pg = {
    async query<T = unknown>(sql: string, _params?: unknown[]) {
      calls.push(sql);
      if (sql.includes("FROM portal.biometric_vectors")) {
        if (script.identityDistance == null) return { rows: [] as T[] };
        return { rows: [{ trust_id: "trust-existing", distance: script.identityDistance }] as T[] };
      }
      if (sql.includes("FROM portal.trusted_devices")) {
        if (script.knownDevice) return { rows: [{ id: "dev-1", status: "ACTIVE" }] as T[] };
        return { rows: [] as T[] };
      }
      if (sql.includes("INSERT INTO portal.master_approval_requests")) {
        return { rows: [{ session_id: "session-pending-1" }] as T[] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async connect() {
      return {
        async query<T = unknown>(sql: string, _params?: unknown[]) {
          calls.push(sql);
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] as T[] };
          if (sql.includes("INSERT INTO portal.trust_id_registry")) {
            return { rows: [{ trust_id: "trust-new-1" }] as T[] };
          }
          return { rows: [] as T[] };
        },
        release() {},
      };
    },
  };

  app.decorate("pg", pg);
  app.decorate("jwt", {
    sign(payload: Record<string, unknown>) {
      return `jwt-${String(payload.trustId ?? "unknown")}`;
    },
  });

  return { app, calls };
}

describe("trustIdAuthRoutes", () => {
  it("returns pending master approval when face exists but device is unknown", async () => {
    const { app } = makeApp({ identityDistance: 0.05, knownDevice: false });
    await trustIdAuthRoutes(app);
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/trustid/auth",
      payload: {
        fullName: "Alice",
        faceVectorPayload: face512(),
        livenessToken: "token-with-sufficient-length",
        deviceFingerprint: "device-xyz",
        deviceName: "Pixel",
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("PENDING_MASTER_APPROVAL");
    expect(body.sessionId).toBe("session-pending-1");
  });

  it("authenticates known active device for matched face", async () => {
    const { app } = makeApp({ identityDistance: 0.05, knownDevice: true });
    await trustIdAuthRoutes(app);
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/trustid/auth",
      payload: {
        faceVectorPayload: face512(),
        livenessToken: "token-with-sufficient-length",
        deviceFingerprint: "device-known",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("AUTHENTICATED");
    expect(body.trustId).toBe("trust-existing");
    expect(body.token).toBe("jwt-trust-existing");
  });

  it("enrolls new account when no vector match exists", async () => {
    const { app, calls } = makeApp({ identityDistance: null, knownDevice: false });
    await trustIdAuthRoutes(app);
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/trustid/auth",
      payload: {
        fullName: "Sovereign User",
        faceVectorPayload: face512(),
        livenessToken: "token-with-sufficient-length",
        deviceFingerprint: "device-new",
        deviceName: "New Phone",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("AUTHENTICATED");
    expect(body.trustId).toBe("trust-new-1");
    expect(calls.some((q) => q.includes("INSERT INTO portal.trust_id_registry"))).toBe(true);
  });
});
