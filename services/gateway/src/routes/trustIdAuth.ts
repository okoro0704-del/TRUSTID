import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

interface AuthBody {
  fullName?: string;
  faceVectorPayload: number[];
  livenessToken: string;
  deviceFingerprint: string;
  deviceName?: string;
}

type PgLike = {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  connect: () => Promise<{
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    release: () => void;
  }>;
};

type JwtLike = {
  sign: (payload: Record<string, unknown>, opts?: { expiresIn?: string }) => string;
};

const SIMILARITY_THRESHOLD = 0.15;

export async function trustIdAuthRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/api/v1/trustid/auth",
    async (request: FastifyRequest<{ Body: AuthBody }>, reply: FastifyReply) => {
      const {
        faceVectorPayload,
        livenessToken,
        deviceFingerprint,
        deviceName,
      } = request.body ?? ({} as AuthBody);

      if (!Array.isArray(faceVectorPayload) || faceVectorPayload.length !== 512) {
        return reply.status(400).send({ error: "faceVectorPayload must be a 512D array." });
      }
      if (!deviceFingerprint?.trim()) {
        return reply.status(400).send({ error: "deviceFingerprint is required." });
      }

      const isLive = await verifyLiveness(livenessToken);
      if (!isLive) {
        return reply.status(400).send({ error: "Liveness verification failed." });
      }

      const pg = (fastify as FastifyInstance & { pg: PgLike }).pg;
      const vectorString = JSON.stringify(faceVectorPayload);
      const existingIdentity = await pg.query<{ trust_id: string; distance: number }>(
        `SELECT trust_id, (face_embedding <=> $1::vector) as distance
         FROM portal.biometric_vectors
         ORDER BY distance ASC LIMIT 1`,
        [vectorString],
      );

      if (
        existingIdentity.rows.length > 0 &&
        Number(existingIdentity.rows[0]?.distance) < SIMILARITY_THRESHOLD
      ) {
        const existingTrustId = existingIdentity.rows[0]!.trust_id;

        const deviceRes = await pg.query<{ id: string; status: string }>(
          `SELECT id, status FROM portal.trusted_devices
           WHERE trust_id = $1 AND device_fingerprint = $2`,
          [existingTrustId, deviceFingerprint],
        );

        const isKnownDevice =
          deviceRes.rows.length > 0 && String(deviceRes.rows[0]?.status ?? "") === "ACTIVE";

        if (!isKnownDevice) {
          const approvalSession = await pg.query<{ session_id: string }>(
            `INSERT INTO portal.master_approval_requests
             (trust_id, requesting_device_fingerprint, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '5 minutes')
             RETURNING session_id`,
            [existingTrustId, deviceFingerprint],
          );

          await notifyMasterDevice(existingTrustId, approvalSession.rows[0]!.session_id, deviceName);

          return reply.status(202).send({
            status: "PENDING_MASTER_APPROVAL",
            message: "Account exists. Biometric sign-off requested on your Master Device.",
            sessionId: approvalSession.rows[0]!.session_id,
          });
        }

        return createTrustIdSession(existingTrustId, reply, fastify);
      }

      // Identity creation is owned by the API's canonical duplicate-enrollment gate
      // (serialized ANN retrieval + exact rerank). A Top-1 check here is neither
      // serialized nor reranked, so this route must never create identities.
      return reply.status(409).send({
        error: "ENROLLMENT_REQUIRES_CANONICAL_GATE",
        message: "No matching identity. Enroll through POST /v1/identity/register-trust-id.",
      });
    },
  );
}

export async function verifyLiveness(token: string): Promise<boolean> {
  return Boolean(token && token.length > 10);
}

export async function notifyMasterDevice(
  _trustId: string,
  _sessionId: string,
  _deviceName?: string,
) {
  // Push notification / WebSocket relay trigger to Master Device
}

export async function createTrustIdSession(
  trustId: string,
  reply: FastifyReply,
  fastify: FastifyInstance,
  statusCode = 200,
) {
  const jwt = (fastify as FastifyInstance & { jwt: JwtLike }).jwt;
  const token = jwt.sign({ trustId }, { expiresIn: "24h" });
  return reply.status(statusCode).send({
    status: "AUTHENTICATED",
    trustId,
    token,
  });
}
