import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  AUDIT_EVENTS,
  DEVICE_APPROVAL_STATUS,
  DEVICE_STATUS,
  DEVICE_TRUST_LEVELS,
} from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { hashSecret, randomToken } from "../src/lib/crypto.js";
import { createSession } from "../src/modules/sessions/service.js";
import {
  createDeviceApprovalRequest,
  getApprovalStatusByPollToken,
} from "../src/modules/device-approval/service.js";
import { transitionApprovalFsm } from "../src/modules/device-approval/fsm.js";
import {
  MockElfComConsentDispatcher,
  setElfComConsentDispatcher,
  resetElfComConsentDispatcher,
} from "../src/modules/elfcom/index.js";
import { __resetRealtimeHubForTests } from "../src/modules/realtime/index.js";
import { resetTables } from "./helpers/db.js";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";

async function createPrimaryDevice(userId: string) {
  return prisma.device.create({
    data: {
      userId,
      name: "Primary Phone",
      status: DEVICE_STATUS.ACTIVE,
      trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
    },
  });
}

function waitForWsMessage<T>(socket: WebSocket, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket message timeout")), timeoutMs);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as T);
    });
  });
}

describe("Realtime device approval OOB", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let baseUrl: string;
  let mockElfCom: MockElfComConsentDispatcher;

  beforeEach(async () => {
    await resetTables(prisma);
    __resetRealtimeHubForTests();
    resetElfComConsentDispatcher();
    mockElfCom = new MockElfComConsentDispatcher();
    setElfComConsentDispatcher(mockElfCom);

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 8787;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("dispatches ElfCom push and transitions PENDING -> PUSHED", async () => {
    const user = await createZeroPiiUser("push@example.com");
    await createPrimaryDevice(user.id);

    const created = await createDeviceApprovalRequest({
      email: "push@example.com",
      deviceName: "Guest laptop",
      applicationName: "LifeOS",
    });

    expect(mockElfCom.pushes).toHaveLength(1);
    expect(mockElfCom.pushes[0]?.correlationId).toBeTruthy();
    expect(mockElfCom.pushes[0]?.silent).toBe(true);

    const row = await prisma.deviceApprovalRequest.findUniqueOrThrow({
      where: { id: created.requestId },
    });
    expect(row.status).toBe(DEVICE_APPROVAL_STATUS.PUSHED);
    expect(row.pushDispatchedAt).toBeTruthy();
    expect(row.correlationId).toBe(created.correlationId);
  });

  it("falls back to PENDING when ElfCom push fails", async () => {
    mockElfCom.shouldFail = true;
    const user = await createZeroPiiUser("failpush@example.com");
    await createPrimaryDevice(user.id);

    await createDeviceApprovalRequest({
      email: "failpush@example.com",
      deviceName: "Guest PC",
    });

    const row = await prisma.deviceApprovalRequest.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.status).toBe(DEVICE_APPROVAL_STATUS.PENDING);
    expect(row.pushFailedAt).toBeTruthy();
    expect(row.pushDispatchedAt).toBeNull();
  });

  it("master WebSocket receives approval.created in real time", async () => {
    const user = await createZeroPiiUser("master-ws@example.com");
    const primary = await createPrimaryDevice(user.id);
    const { token } = await createSession({
      userId: user.id,
      deviceId: primary.id,
    });

    const wsUrl = baseUrl.replace(/^http/, "ws");
    const masterWs = new WebSocket(`${wsUrl}/realtime/approvals?session=${token}`);
    await new Promise<void>((resolve, reject) => {
      masterWs.once("open", () => resolve());
      masterWs.once("error", reject);
    });
    const connected = await waitForWsMessage<{ type: string; role: string }>(masterWs);
    expect(connected.type).toBe("connected");
    expect(connected.role).toBe("master");

    const events: Array<{ type?: string; requestId?: string; status?: string }> = [];
    const eventsReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("approval events timeout")), 5000);
      const onMessage = (data: WebSocket.RawData) => {
        events.push(JSON.parse(data.toString()));
        const hasCreated = events.some((e) => e.type === "approval.created");
        const hasPushed = events.some((e) => e.status === DEVICE_APPROVAL_STATUS.PUSHED);
        if (hasCreated && hasPushed) {
          clearTimeout(timer);
          masterWs.off("message", onMessage);
          resolve();
        }
      };
      masterWs.on("message", onMessage);
    });

    const created = await createDeviceApprovalRequest({
      email: "master-ws@example.com",
      deviceName: "Library terminal",
    });

    await eventsReady;

    expect(events.some((e) => e.type === "approval.created")).toBe(true);
    expect(events.some((e) => e.requestId === created.requestId)).toBe(true);
    expect(events.some((e) => e.status === DEVICE_APPROVAL_STATUS.PUSHED)).toBe(true);

    masterWs.close();
  });

  it("guest WebSocket receives approval.resolved when master denies", async () => {
    const user = await createZeroPiiUser("guest-ws@example.com");
    await createPrimaryDevice(user.id);

    const created = await createDeviceApprovalRequest({
      email: "guest-ws@example.com",
      deviceName: "Airport kiosk",
    });

    const wsUrl = baseUrl.replace(/^http/, "ws");
    const guestWs = new WebSocket(
      `${wsUrl}/realtime/approvals/guest?pollToken=${created.pollToken}`,
    );
    await new Promise<void>((resolve, reject) => {
      guestWs.once("open", () => resolve());
      guestWs.once("error", reject);
    });
    await waitForWsMessage(guestWs);

    const row = await prisma.deviceApprovalRequest.findUniqueOrThrow({
      where: { id: created.requestId },
    });
    await transitionApprovalFsm({
      row,
      event: "denied",
      audit: { type: AUDIT_EVENTS.DEVICE_APPROVAL_DECLINED, actorType: "user", actorId: user.id },
    });

    const resolved = await waitForWsMessage<{ type: string; status: string }>(guestWs);
    expect(resolved.type).toBe("approval.resolved");
    expect(resolved.status).toBe(DEVICE_APPROVAL_STATUS.DECLINED);

    guestWs.close();
  });

  it("expires timed-out approvals and notifies guest over WebSocket", async () => {
    const user = await createZeroPiiUser("expire-ws@example.com");
    await createPrimaryDevice(user.id);

    const created = await createDeviceApprovalRequest({
      email: "expire-ws@example.com",
      deviceName: "Stale terminal",
    });

    const wsUrl = baseUrl.replace(/^http/, "ws");
    const guestWs = new WebSocket(
      `${wsUrl}/realtime/approvals/guest?pollToken=${created.pollToken}`,
    );
    await new Promise<void>((resolve, reject) => {
      guestWs.once("open", () => resolve());
      guestWs.once("error", reject);
    });
    await waitForWsMessage(guestWs);

    await prisma.deviceApprovalRequest.update({
      where: { id: created.requestId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const status = await getApprovalStatusByPollToken(created.pollToken);
    expect(status.status).toBe(DEVICE_APPROVAL_STATUS.EXPIRED);

    const resolved = await waitForWsMessage<{ type: string; status: string }>(guestWs);
    expect(resolved.type).toBe("approval.resolved");
    expect(resolved.status).toBe(DEVICE_APPROVAL_STATUS.EXPIRED);

    guestWs.close();
  });

  it("mark viewed transitions PUSHED -> VIEWED via HTTP", async () => {
    const user = await createZeroPiiUser("viewed@example.com");
    const primary = await createPrimaryDevice(user.id);
    const { token } = await createSession({
      userId: user.id,
      deviceId: primary.id,
    });

    const created = await createDeviceApprovalRequest({
      email: "viewed@example.com",
      deviceName: "Cafe PC",
    });

    const res = await app.inject({
      method: "POST",
      url: `/device-approvals/${created.requestId}/viewed`,
      headers: { "x-trustid-session": token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe(DEVICE_APPROVAL_STATUS.VIEWED);

    const row = await prisma.deviceApprovalRequest.findUniqueOrThrow({
      where: { id: created.requestId },
    });
    expect(row.viewedAt).toBeTruthy();
  });
});
