import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { hashSecret } from "../../lib/crypto.js";
import { tryResolveSession } from "../../lib/auth-context.js";
import { prisma } from "../../db/client.js";
import { subscribeGuest, subscribeMaster } from "./hub.js";
import type { RealtimeClientMessage } from "./types.js";
import { markApprovalViewed } from "../device-approval/service.js";

function parseClientMessage(raw: unknown): RealtimeClientMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as RealtimeClientMessage;
    if (parsed && typeof parsed === "object" && "action" in parsed) return parsed;
    return null;
  } catch {
    return null;
  }
}

async function resolveMasterAuth(req: {
  headers: Record<string, unknown>;
  cookies?: Record<string, string | undefined>;
  query?: Record<string, unknown>;
}) {
  const sessionHeader =
    typeof req.headers["x-trustid-session"] === "string"
      ? req.headers["x-trustid-session"]
      : undefined;
  const querySession =
    typeof req.query?.session === "string" ? req.query.session : undefined;

  const fakeReq = {
    headers: {
      ...(sessionHeader || querySession
        ? { authorization: `Bearer ${sessionHeader ?? querySession}` }
        : {}),
      cookie: req.headers.cookie,
    },
    cookies: req.cookies ?? {},
  } as Parameters<typeof tryResolveSession>[0];

  if (querySession && !sessionHeader) {
    fakeReq.headers["x-trustid-session"] = querySession;
  }

  return tryResolveSession(fakeReq);
}

export async function registerRealtimeGateway(app: FastifyInstance) {
  app.get(
    "/realtime/approvals",
    { websocket: true },
    async (socket: WebSocket, req) => {
      const auth = await resolveMasterAuth({
        headers: req.headers as Record<string, unknown>,
        cookies: req.cookies,
        query: req.query as Record<string, unknown>,
      });
      if (!auth?.userId) {
        socket.send(JSON.stringify({ type: "error", message: "Sign in required" }));
        socket.close(4401, "unauthorized");
        return;
      }

      const unsubscribe = subscribeMaster(auth.userId, socket);

      socket.on("message", async (raw) => {
        const msg = parseClientMessage(raw.toString());
        if (!msg) return;
        if (msg.action === "ping") {
          socket.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
          return;
        }
        if (msg.action === "mark_viewed" && msg.requestId) {
          try {
            await markApprovalViewed({
              userId: auth.userId,
              deviceId: auth.deviceId,
              requestId: msg.requestId,
            });
          } catch (err) {
            socket.send(
              JSON.stringify({
                type: "error",
                message: err instanceof Error ? err.message : "mark_viewed failed",
              }),
            );
          }
        }
      });

      socket.on("close", () => unsubscribe());
      socket.on("error", () => unsubscribe());
    },
  );

  app.get(
    "/realtime/approvals/guest",
    { websocket: true },
    async (socket: WebSocket, req) => {
      const query = req.query as Record<string, unknown> | undefined;
      const pollToken =
        typeof query?.pollToken === "string" ? query.pollToken.trim() : "";
      if (pollToken.length < 10) {
        socket.send(JSON.stringify({ type: "error", message: "pollToken required" }));
        socket.close(4400, "bad_request");
        return;
      }

      const pollTokenHash = hashSecret(pollToken);
      const row = await prisma.deviceApprovalRequest.findUnique({
        where: { pollTokenHash },
      });
      if (!row) {
        socket.send(JSON.stringify({ type: "error", message: "Approval not found" }));
        socket.close(4404, "not_found");
        return;
      }

      const unsubscribe = subscribeGuest(pollTokenHash, socket);

      socket.on("message", (raw) => {
        const msg = parseClientMessage(raw.toString());
        if (msg?.action === "ping") {
          socket.send(JSON.stringify({ type: "pong", at: new Date().toISOString() }));
        }
      });

      socket.on("close", () => unsubscribe());
      socket.on("error", () => unsubscribe());
    },
  );
}
