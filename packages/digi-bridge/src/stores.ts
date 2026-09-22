import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  DigiOwner,
  DigiSession,
  ExternalIdentity,
  OwnerStore,
  ReplayStore,
  SessionStore,
} from "./types.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

/**
 * In-memory Digi stores for tests. Production Digi RP uses durable DB.
 * Unique (issuer, subject) enforced; concurrent create races recover.
 */
export function createMemoryOwnerStore(): OwnerStore {
  const byKey = new Map<string, ExternalIdentity>();
  const owners = new Map<string, DigiOwner>();
  const locks = new Map<string, Promise<void>>();

  function key(issuer: string, subject: string) {
    return `${issuer}\0${subject}`;
  }

  async function withLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(k) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    locks.set(
      k,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    async findByIssuerSubject(issuer, subject) {
      return byKey.get(key(issuer, subject)) ?? null;
    },
    async resolveOrCreate({ issuer, subject }) {
      const k = key(issuer, subject);
      return withLock(k, async () => {
        const existing = byKey.get(k);
        if (existing) {
          existing.lastSeenAt = new Date();
          const owner = owners.get(existing.ownerId)!;
          owner.updatedAt = new Date();
          return { owner, created: false, identity: existing };
        }
        const now = new Date();
        const owner: DigiOwner = {
          id: newId("own"),
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
        const identity: ExternalIdentity = {
          id: newId("xid"),
          ownerId: owner.id,
          issuer,
          subject,
          createdAt: now,
          lastSeenAt: now,
        };
        owners.set(owner.id, owner);
        byKey.set(k, identity);
        return { owner, created: true, identity };
      });
    },
  };
}

export function createMemoryReplayStore(): ReplayStore {
  const consumed = new Map<string, { issuer: string; subject: string; expiresAt: Date }>();
  const locks = new Map<string, Promise<void>>();

  async function withLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(k) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    locks.set(
      k,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    async tryConsume(input) {
      return withLock(input.jti, async () => {
        if (consumed.has(input.jti)) return false;
        consumed.set(input.jti, {
          issuer: input.issuer,
          subject: input.subject,
          expiresAt: input.expiresAt,
        });
        return true;
      });
    },
  };
}

export function createMemorySessionStore(): SessionStore {
  const byHash = new Map<string, DigiSession>();
  const byId = new Map<string, DigiSession>();

  return {
    async create({ ownerId, ttlSeconds = 60 * 60 * 8 }) {
      const token = randomBytes(32).toString("base64url");
      const tokenHash = hashToken(token);
      const now = new Date();
      const session: DigiSession = {
        id: newId("ses"),
        ownerId,
        tokenHash,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
        createdAt: now,
        revokedAt: null,
      };
      byHash.set(tokenHash, session);
      byId.set(session.id, session);
      return { session, token };
    },
    async resolve(token) {
      const session = byHash.get(hashToken(token));
      if (!session) return null;
      if (session.revokedAt) return null;
      if (session.expiresAt.getTime() < Date.now()) return null;
      return session;
    },
    async revoke(sessionId) {
      const session = byId.get(sessionId);
      if (session) session.revokedAt = new Date();
    },
  };
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
