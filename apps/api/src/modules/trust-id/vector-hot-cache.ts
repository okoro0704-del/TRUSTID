import { BIOMETRIC_AI_EMBEDDING_DIMS } from "@trustid/shared";

export type HotVectorHit = {
  userId: string;
  trustId: string;
  embeddingId: string;
  distance: number;
  source: "memory" | "redis";
};

type HotEntry = {
  userId: string;
  trustId: string;
  embeddingId: string;
  vector: Float32Array;
  lastAccess: number;
};

const MEMORY_CAP = 256;
const REDIS_KEY = "trustid:hot_vectors:v1";
const REDIS_TTL_SEC = 60 * 60 * 24; // 24h
const TRUST_VEC_PREFIX = "user_vec:";

/** In-memory index by trustId for O(1) 1:1 lookups */
const byTrustId = new Map<string, HotEntry>();

const memory = new Map<string, HotEntry>();

let redisClient: {
  get: (key: string) => Promise<string | null>;
  set: (
    key: string,
    value: string,
    options?: { EX?: number },
  ) => Promise<unknown>;
  quit?: () => Promise<unknown>;
} | null = null;
let redisInitAttempted = false;

function cosineDistance(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!;
  return 1 - dot;
}

function toFloat32(vector: number[]): Float32Array {
  const out = new Float32Array(BIOMETRIC_AI_EMBEDDING_DIMS);
  for (let i = 0; i < BIOMETRIC_AI_EMBEDDING_DIMS; i++) {
    out[i] = vector[i] ?? 0;
  }
  return out;
}

function touchMemory(entry: HotEntry) {
  entry.lastAccess = Date.now();
  memory.set(entry.userId, entry);
  byTrustId.set(entry.trustId, entry);
  if (memory.size <= MEMORY_CAP) return;
  let oldestKey: string | null = null;
  let oldest = Infinity;
  for (const [k, v] of memory) {
    if (v.lastAccess < oldest) {
      oldest = v.lastAccess;
      oldestKey = k;
    }
  }
  if (oldestKey) {
    const removed = memory.get(oldestKey);
    memory.delete(oldestKey);
    if (removed) byTrustId.delete(removed.trustId);
  }
}

async function getRedis() {
  if (redisInitAttempted) return redisClient;
  redisInitAttempted = true;
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  try {
    const mod = await import("redis");
    const client = mod.createClient({ url });
    client.on("error", (err: Error) => {
      console.warn("[vector-cache] redis error:", err.message);
    });
    await client.connect();
    redisClient = client;
    console.log("[vector-cache] redis hot cache connected");
    return redisClient;
  } catch (err) {
    console.warn(
      "[vector-cache] redis unavailable ù using in-process LRU only:",
      err instanceof Error ? err.message : err,
    );
    redisClient = null;
    return null;
  }
}

type RedisBlob = {
  entries: Array<{
    userId: string;
    trustId: string;
    embeddingId: string;
    vector: number[];
  }>;
};

async function loadRedisEntries(): Promise<HotEntry[]> {
  const client = await getRedis();
  if (!client) return [];
  try {
    const raw = await client.get(REDIS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RedisBlob;
    return (parsed.entries ?? []).map((e) => ({
      userId: e.userId,
      trustId: e.trustId,
      embeddingId: e.embeddingId,
      vector: toFloat32(e.vector),
      lastAccess: Date.now(),
    }));
  } catch {
    return [];
  }
}

async function persistRedis(entries: HotEntry[]) {
  const client = await getRedis();
  if (!client) return;
  try {
    const blob: RedisBlob = {
      entries: entries.slice(0, MEMORY_CAP).map((e) => ({
        userId: e.userId,
        trustId: e.trustId,
        embeddingId: e.embeddingId,
        vector: Array.from(e.vector),
      })),
    };
    await client.set(REDIS_KEY, JSON.stringify(blob), { EX: REDIS_TTL_SEC });
  } catch (err) {
    console.warn(
      "[vector-cache] redis write failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Search recently-active face vectors in memory (+ Redis when configured).
 * Designed for sub-5ms hits on the hot set without Redis Stack VSS.
 */
export async function searchHotVectorCache(
  queryVector: number[],
  maxDistance: number,
): Promise<HotVectorHit | null> {
  const probe = toFloat32(queryVector);
  let best: HotVectorHit | null = null;

  for (const entry of memory.values()) {
    const distance = cosineDistance(probe, entry.vector);
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance) {
      best = {
        userId: entry.userId,
        trustId: entry.trustId,
        embeddingId: entry.embeddingId,
        distance,
        source: "memory",
      };
    }
  }
  if (best) {
    const hit = memory.get(best.userId);
    if (hit) touchMemory(hit);
    return best;
  }

  const redisEntries = await loadRedisEntries();
  for (const entry of redisEntries) {
    touchMemory(entry);
    const distance = cosineDistance(probe, entry.vector);
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance) {
      best = {
        userId: entry.userId,
        trustId: entry.trustId,
        embeddingId: entry.embeddingId,
        distance,
        source: "redis",
      };
    }
  }
  return best;
}

/** Cache a matched / enrolled vector for subsequent ultra-fast logins. */
export async function cacheUserVector(input: {
  userId: string;
  trustId: string;
  embeddingId: string;
  vector: number[];
}): Promise<void> {
  const entry: HotEntry = {
    userId: input.userId,
    trustId: input.trustId,
    embeddingId: input.embeddingId,
    vector: toFloat32(input.vector),
    lastAccess: Date.now(),
  };
  touchMemory(entry);
  void persistRedis([...memory.values()].sort((a, b) => b.lastAccess - a.lastAccess));
  void persistTrustVector(input.trustId, Array.from(entry.vector));
}

async function persistTrustVector(trustId: string, vector: number[]) {
  const client = await getRedis();
  if (!client) return;
  try {
    await client.set(
      `${TRUST_VEC_PREFIX}${trustId}`,
      JSON.stringify(vector),
      { EX: REDIS_TTL_SEC },
    );
  } catch {
    /* optional */
  }
}

/**
 * Fetch a single known user's face vector for Path A 1:1 verification.
 * Memory ? Redis `user_vec:{trustId}` ? null (caller loads DB).
 */
export async function getCachedVectorByTrustId(
  trustId: string,
): Promise<{
  userId: string;
  trustId: string;
  embeddingId: string;
  vector: number[];
  source: "memory" | "redis";
} | null> {
  const mem = byTrustId.get(trustId);
  if (mem) {
    touchMemory(mem);
    return {
      userId: mem.userId,
      trustId: mem.trustId,
      embeddingId: mem.embeddingId,
      vector: Array.from(mem.vector),
      source: "memory",
    };
  }

  const client = await getRedis();
  if (!client) return null;
  try {
    const raw = await client.get(`${TRUST_VEC_PREFIX}${trustId}`);
    if (!raw) return null;
    const vector = JSON.parse(raw) as number[];
    if (!Array.isArray(vector) || vector.length < 8) return null;
    return {
      userId: "",
      trustId,
      embeddingId: "",
      vector,
      source: "redis",
    };
  } catch {
    return null;
  }
}

/** Test helper ó wipe in-process cache. */
export function __clearHotVectorCacheForTests() {
  memory.clear();
  byTrustId.clear();
}
