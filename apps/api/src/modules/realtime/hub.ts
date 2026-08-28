import type { WebSocket } from "ws";
import type { RealtimeApprovalMessage, RealtimeServerMessage } from "./types.js";

type Subscriber = {
  socket: WebSocket;
  role: "master" | "guest";
};

const masterChannels = new Map<string, Set<Subscriber>>();
const guestChannels = new Map<string, Set<Subscriber>>();

function channelKey(userId: string) {
  return userId;
}

function guestKey(pollTokenHash: string) {
  return pollTokenHash;
}

function send(socket: WebSocket, message: RealtimeServerMessage) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function addSubscriber(
  map: Map<string, Set<Subscriber>>,
  key: string,
  subscriber: Subscriber,
) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(subscriber);
}

function removeSubscriber(map: Map<string, Set<Subscriber>>, key: string, socket: WebSocket) {
  const set = map.get(key);
  if (!set) return;
  for (const sub of set) {
    if (sub.socket === socket) set.delete(sub);
  }
  if (set.size === 0) map.delete(key);
}

export function subscribeMaster(userId: string, socket: WebSocket) {
  const subscriber: Subscriber = { socket, role: "master" };
  addSubscriber(masterChannels, channelKey(userId), subscriber);
  send(socket, { type: "connected", role: "master", at: new Date().toISOString() });
  return () => removeSubscriber(masterChannels, channelKey(userId), socket);
}

export function subscribeGuest(pollTokenHash: string, socket: WebSocket) {
  const subscriber: Subscriber = { socket, role: "guest" };
  addSubscriber(guestChannels, guestKey(pollTokenHash), subscriber);
  send(socket, { type: "connected", role: "guest", at: new Date().toISOString() });
  return () => removeSubscriber(guestChannels, guestKey(pollTokenHash), socket);
}

export function broadcastApprovalEvent(input: {
  userId: string;
  pollTokenHash: string;
  message: RealtimeApprovalMessage;
}) {
  const masterSet = masterChannels.get(channelKey(input.userId));
  if (masterSet) {
    for (const sub of masterSet) send(sub.socket, input.message);
  }
  const guestSet = guestChannels.get(guestKey(input.pollTokenHash));
  if (guestSet) {
    for (const sub of guestSet) send(sub.socket, input.message);
  }
}

/** Test helper — reset all in-memory subscriptions. */
export function __resetRealtimeHubForTests() {
  masterChannels.clear();
  guestChannels.clear();
}

export function masterSubscriberCount(userId: string) {
  return masterChannels.get(channelKey(userId))?.size ?? 0;
}

export function guestSubscriberCount(pollTokenHash: string) {
  return guestChannels.get(guestKey(pollTokenHash))?.size ?? 0;
}
