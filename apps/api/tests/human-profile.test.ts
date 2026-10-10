/**
 * TrustID Human Profile V1: self-declared profile, private avatar, optional
 * identity document, Digi AI addressing interface, OIDC profile claims.
 * Real Fastify app and Prisma test database; no mocks.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as jose from "jose";
import { SCOPES } from "@trustid/shared";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { createAuthorizationCode } from "../src/modules/authorization/service.js";
import { createSession } from "../src/modules/sessions/service.js";
import { createMediaAccessToken } from "../src/modules/verified-identity/media.js";
import { getDataZoneClient, setDataZoneClient } from "../src/modules/baas/registry.js";
import { DOCUMENT_CONSENT_VERSION } from "../src/modules/human-profile/service.js";
import {
  __clearVerificationProvidersForTests,
  applyProviderDecision,
  registerDocumentVerificationProvider,
} from "../src/modules/human-profile/verification.js";
import { resetTables } from "./helpers/db.js";
import { PORTAL, pkcePair, portalTokens } from "./helpers/portal-oauth.js";
import { bootstrapPortalClients } from "../src/lib/bootstrap-oauth-apps.js";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";
import {
  SECRET_METADATA,
  TRAILING_PAYLOAD,
  dataUrl,
  jpegFixture,
  pngFixture,
  webpFixture,
} from "./helpers/images.js";

let app: Awaited<ReturnType<typeof buildApp>>;

const DIGI_AI = {
  clientId: "digi_ai_profile_test",
  redirectUri: "https://digi.example.test/callback",
  scopes: [SCOPES.OPENID, SCOPES.IDENTITY_BASIC, SCOPES.PROFILE, SCOPES.IDENTITY_ADDRESSING],
};

beforeEach(async () => {
  await resetTables(prisma);
  app = await buildApp();
});

afterEach(() => __clearVerificationProvidersForTests());

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

async function human(name = "user") {
  const user = await createZeroPiiUser(`${name}-${Math.random().toString(36).slice(2)}@example.test`);
  const { token } = await createSession({ userId: user.id });
  return { user, headers: { "x-trustid-session": token } };
}

type Headers = Record<string, string>;
const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, headers?: Headers, payload?: unknown) =>
  app.inject({ method, url, headers, payload: payload as object | undefined });

const ADA = { givenName: "Adaeze", familyName: "Okafor", preferredName: "Ada" };

async function withProfile(name = "ada") {
  const h = await human(name);
  const res = await call("PUT", "/v1/profile", h.headers, ADA);
  expect(res.statusCode).toBe(200);
  return h;
}

async function fetchMedia(access: { path: string; token: string }) {
  return call("GET", `${access.path}?token=${encodeURIComponent(access.token)}`);
}

async function clientTokens(userId: string, client: typeof DIGI_AI, scopes: string[]) {
  const { verifier, challenge } = pkcePair();
  const { code } = await createAuthorizationCode({
    userId,
    clientId: client.clientId,
    redirectUri: client.redirectUri,
    scopes,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  });
  const res = await call("POST", "/oauth/token", undefined, {
    grant_type: "authorization_code",
    code,
    redirect_uri: client.redirectUri,
    client_id: client.clientId,
    code_verifier: verifier,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { access_token: string; id_token?: string; scope: string };
}

async function registerDigiAiClient() {
  await prisma.application.create({
    data: {
      clientId: DIGI_AI.clientId,
      name: "Digi AI (test)",
      type: "public",
      redirectUris: JSON.stringify([DIGI_AI.redirectUri]),
      allowedScopes: JSON.stringify(DIGI_AI.scopes),
    },
  });
}

async function submitDocument(headers: Headers) {
  const res = await call("POST", "/v1/profile/documents", headers, {
    documentType: "passport",
    imageDataUrl: dataUrl("image/png", pngFixture({ width: 400, height: 400 })),
    consent: { accepted: true, version: DOCUMENT_CONSENT_VERSION },
  });
  expect(res.statusCode).toBe(201);
  return res.json().document as { id: string; verificationStatus: string; verificationProvider: string };
}

describe("profile creation, update and subject binding", () => {
  it("requires an authenticated session and never creates an account", async () => {
    const before = await prisma.user.count();
    expect((await call("GET", "/v1/profile")).statusCode).toBe(401);
    expect((await call("PUT", "/v1/profile", undefined, ADA)).statusCode).toBe(401);
    expect((await call("PUT", "/v1/profile", { "x-trustid-session": "forged" }, ADA)).statusCode).toBe(401);
    expect(await prisma.user.count()).toBe(before);
    expect(await prisma.humanProfile.count()).toBe(0);
  });

  it("binds the profile to the session's TrustID subject and seals names at rest", async () => {
    const { user, headers } = await human();
    const res = await call("PUT", "/v1/profile", headers, { ...ADA, displayName: "Adaeze O." });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subjectId).toBe(user.trustId);
    expect(body.profile).toMatchObject({
      subjectId: user.trustId,
      givenName: "Adaeze",
      familyName: "Okafor",
      preferredName: "Ada",
      displayName: "Adaeze O.",
      avatarAssetId: null,
      profileVersion: 1,
    });
    expect(body.nameVerification).toBe("SELF_DECLARED");
    const row = await prisma.humanProfile.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.subjectId).toBe(user.trustId);
    expect(row.namesSealed).not.toMatch(/Adaeze|Okafor|Ada/);
  });

  it("updates with optimistic concurrency and rejects a caller-chosen subject", async () => {
    const { headers } = await withProfile();
    const update = await call("PUT", "/v1/profile", headers, { givenName: "Adaeze", preferredName: "Daze", expectedVersion: 1 });
    expect(update.statusCode).toBe(200);
    expect(update.json().profile).toMatchObject({ preferredName: "Daze", familyName: "", profileVersion: 2, displayName: "Adaeze" });
    const stale = await call("PUT", "/v1/profile", headers, { givenName: "X", expectedVersion: 1 });
    expect(stale.statusCode).toBe(409);
    const other = await human("mallory");
    const hijack = await call("PUT", "/v1/profile", headers, { ...ADA, subjectId: other.user.trustId });
    expect(hijack.statusCode).toBe(400);
  });

  it("validates names (required given name, no markup or control characters, bounded length)", async () => {
    const { headers } = await human();
    for (const bad of [
      { givenName: "" },
      { givenName: "   " },
      { givenName: "<script>" },
      { givenName: "A\u0000B" },
      { givenName: "a".repeat(101) },
      { givenName: "Ada", preferredName: "x".repeat(61) },
    ]) {
      expect((await call("PUT", "/v1/profile", headers, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const ok = await call("PUT", "/v1/profile", headers, { givenName: "  Zoë   N'Dour-Smith  " });
    expect(ok.json().profile.givenName).toBe("Zoë N'Dour-Smith");
  });

  it("denies cross-user access: each session only ever sees and edits its own subject", async () => {
    const ada = await withProfile("ada");
    const bob = await human("bob");
    const bobView = await call("GET", "/v1/profile", bob.headers);
    expect(bobView.json()).toMatchObject({ subjectId: bob.user.trustId, completed: false, profile: null });
    await call("PUT", "/v1/profile", bob.headers, { givenName: "Bob" });
    const adaView = await call("GET", "/v1/profile", ada.headers);
    expect(adaView.json().profile.givenName).toBe("Adaeze");
    const doc = await submitDocument(ada.headers);
    expect((await call("DELETE", `/v1/profile/documents/${doc.id}`, bob.headers)).statusCode).toBe(404);
    expect(await prisma.identityDocumentSubmission.count({ where: { id: doc.id, deletedAt: null } })).toBe(1);
  });
});

describe("profile picture", () => {
  it("stores a sanitized private copy: metadata and trailing data stripped, protected access only", async () => {
    const { user, headers } = await withProfile();
    for (const [mime, bytes] of [
      ["image/png", pngFixture()],
      ["image/jpeg", jpegFixture()],
      ["image/webp", webpFixture()],
    ] as const) {
      const res = await call("PUT", "/v1/profile/avatar", headers, { imageDataUrl: dataUrl(mime, bytes) });
      expect(res.statusCode, mime).toBe(200);
      const { avatar, avatarAssetId } = res.json().profile;
      const media = await prisma.identityMediaObject.findUniqueOrThrow({ where: { id: avatarAssetId } });
      expect(media).toMatchObject({ userId: user.id, purpose: "profile_avatar", mimeType: mime });
      const served = await fetchMedia(avatar);
      expect(served.statusCode).toBe(200);
      expect(served.headers["content-type"]).toBe(mime);
      expect(served.headers["cache-control"]).toBe("private, no-store");
      expect(served.headers["x-content-type-options"]).toBe("nosniff");
      expect(served.rawPayload.includes(Buffer.from(SECRET_METADATA))).toBe(false);
      expect(served.rawPayload.includes(Buffer.from(TRAILING_PAYLOAD))).toBe(false);
      expect(served.rawPayload.length).toBeLessThan(bytes.length);
      // At rest the bytes are encrypted, not the plain image.
      const disk = readFileSync(path.join(process.env.TRUSTID_MEDIA_ROOT!, media.storageKey));
      expect(disk.subarray(0, 4).toString()).toBe("TIDC");
    }
    const tokenless = await call("GET", `/identity/media/${(await prisma.humanProfile.findFirstOrThrow()).avatarMediaId}`);
    expect(tokenless.statusCode).toBeGreaterThanOrEqual(400);
    expect(tokenless.headers["content-type"]).not.toMatch(/^image\//);
  });

  it("rejects invalid content, mismatched types, animation, bad dimensions and oversize uploads", async () => {
    const { headers } = await withProfile();
    const put = (imageDataUrl: string) => call("PUT", "/v1/profile/avatar", headers, { imageDataUrl });
    const cases: [string, string][] = [
      ["png as jpeg", dataUrl("image/jpeg", pngFixture())],
      ["garbage", dataUrl("image/png", Buffer.alloc(500, 7))],
      ["svg", `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`],
      ["gif", dataUrl("image/gif", Buffer.from("GIF89a" + "x".repeat(100)))],
      ["truncated png", dataUrl("image/png", pngFixture().subarray(0, 60))],
      ["corrupt crc", dataUrl("image/png", Buffer.from(pngFixture().map((b, i) => (i === 40 ? b ^ 0xff : b))))],
      ["animated png", dataUrl("image/png", pngFixture({ animated: true }))],
      ["animated webp", dataUrl("image/webp", webpFixture({ animated: true }))],
      ["too small", dataUrl("image/png", pngFixture({ width: 16, height: 16 }))],
      ["too large dimensions", dataUrl("image/jpeg", jpegFixture({ width: 5000, height: 100 }))],
      ["non-canonical base64", "data:image/png;base64,@@@@" + "A".repeat(40)],
    ];
    for (const [label, url] of cases) {
      const res = await put(url);
      expect(res.statusCode, label).toBe(400);
    }
    const huge = await put(dataUrl("image/png", Buffer.concat([pngFixture(), Buffer.alloc(2_300_000)])));
    expect([400, 413]).toContain(huge.statusCode);
    expect((await prisma.humanProfile.findFirstOrThrow()).avatarMediaId).toBeNull();
  });

  it("requires a saved profile, replaces and deletes the picture, and revokes old links", async () => {
    const { headers } = await human();
    expect((await call("PUT", "/v1/profile/avatar", headers, { imageDataUrl: dataUrl("image/png", pngFixture()) })).statusCode).toBe(409);
    await call("PUT", "/v1/profile", headers, ADA);
    const first = (await call("PUT", "/v1/profile/avatar", headers, { imageDataUrl: dataUrl("image/png", pngFixture()) })).json().profile;
    const second = (await call("PUT", "/v1/profile/avatar", headers, { imageDataUrl: dataUrl("image/jpeg", jpegFixture()) })).json().profile;
    expect(second.avatarAssetId).not.toBe(first.avatarAssetId);
    expect(second.profileVersion).toBeGreaterThan(first.profileVersion);
    expect((await fetchMedia(first.avatar)).statusCode).toBe(404);
    const old = await prisma.identityMediaObject.findUniqueOrThrow({ where: { id: first.avatarAssetId } });
    expect(old.deletedAt).not.toBeNull();
    expect(existsSync(path.join(process.env.TRUSTID_MEDIA_ROOT!, old.storageKey))).toBe(false);

    const deleted = await call("DELETE", "/v1/profile/avatar", headers);
    expect(deleted.json().profile).toMatchObject({ avatarAssetId: null, avatar: null });
    expect((await fetchMedia(second.avatar)).statusCode).toBe(404);
  });

  it("is never biometric or identity-portrait evidence", async () => {
    const { user, headers } = await withProfile();
    await call("PUT", "/v1/profile/avatar", headers, { imageDataUrl: dataUrl("image/png", pngFixture()) });
    expect(await prisma.identityPortrait.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.biometricTemplate.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.biometricEmbedding.count({ where: { userId: user.id } })).toBe(0);
    const portrait = await call("GET", "/identity/portrait", headers);
    expect(portrait.statusCode).not.toBe(200);
    expect(portrait.body).not.toContain("/identity/media/");
  });

  it("does not let one user's media token open another user's picture", async () => {
    const ada = await withProfile("ada");
    const adaAvatar = (await call("PUT", "/v1/profile/avatar", ada.headers, { imageDataUrl: dataUrl("image/png", pngFixture()) })).json().profile;
    const bob = await withProfile("bob");
    const bobAvatar = (await call("PUT", "/v1/profile/avatar", bob.headers, { imageDataUrl: dataUrl("image/png", pngFixture()) })).json().profile;
    const swapped = await fetchMedia({ path: adaAvatar.avatar.path, token: bobAvatar.avatar.token });
    expect(swapped.statusCode).toBe(403);
    const forged = createMediaAccessToken({ mediaId: adaAvatar.avatarAssetId, userId: bob.user.id, audience: bob.user.id });
    expect((await fetchMedia({ path: adaAvatar.avatar.path, token: forged.token })).statusCode).toBe(404);
  });
});

describe("identity document (optional, unverified)", () => {
  it("requires explicit consent and records UNVERIFIED / NONE without verification claims", async () => {
    const { headers } = await withProfile();
    const image = dataUrl("image/jpeg", jpegFixture({ width: 1200, height: 800 }));
    for (const consent of [undefined, { accepted: false, version: DOCUMENT_CONSENT_VERSION }, { accepted: true, version: "old" }]) {
      const res = await call("POST", "/v1/profile/documents", headers, { documentType: "passport", imageDataUrl: image, consent });
      expect(res.statusCode).toBe(400);
    }
    const res = await call("POST", "/v1/profile/documents", headers, {
      documentType: "national_id",
      imageDataUrl: image,
      consent: { accepted: true, version: DOCUMENT_CONSENT_VERSION },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.document).toMatchObject({
      documentType: "national_id",
      verificationStatus: "UNVERIFIED",
      verificationProvider: "NONE",
      consentVersion: DOCUMENT_CONSENT_VERSION,
    });
    expect(body.note).toMatch(/not been checked/);
    expect(JSON.stringify(body)).not.toMatch(/verified identity|ocr|liveness|storageKey|base64/i);
  });

  it("is never returned by profile, addressing, userinfo or media APIs", async () => {
    await registerDigiAiClient();
    const { user, headers } = await withProfile();
    const doc = await submitDocument(headers);
    const row = await prisma.identityDocumentSubmission.findUniqueOrThrow({ where: { id: doc.id } });
    const media = await prisma.identityMediaObject.findUniqueOrThrow({ where: { id: row.mediaObjectId! } });

    const own = JSON.stringify((await call("GET", "/v1/profile", headers)).json());
    expect(own).not.toContain(media.storageKey);
    expect(own).not.toContain(media.id);
    expect(own).not.toContain("data:");

    const tokens = await clientTokens(user.id, DIGI_AI, DIGI_AI.scopes);
    const bearer = { authorization: `Bearer ${tokens.access_token}` };
    for (const url of ["/v1/profile/addressing", "/oauth/userinfo"]) {
      const text = (await call("GET", url, bearer)).body;
      expect(text).not.toContain(media.id);
      expect(text).not.toMatch(/document/i);
    }
    // Owner-only OAuth bearer tokens cannot use the owner endpoints at all.
    expect((await call("GET", "/v1/profile", bearer)).statusCode).toBe(401);
    // Even a correctly signed media token never serves a document.
    const token = createMediaAccessToken({ mediaId: media.id, userId: user.id, audience: user.id });
    expect((await fetchMedia({ path: `/identity/media/${media.id}`, token: token.token })).statusCode).toBe(404);
  });

  it("deletes the stored document and detaches it", async () => {
    const { headers } = await withProfile();
    const doc = await submitDocument(headers);
    const row = await prisma.identityDocumentSubmission.findUniqueOrThrow({ where: { id: doc.id } });
    const media = await prisma.identityMediaObject.findUniqueOrThrow({ where: { id: row.mediaObjectId! } });
    const file = path.join(process.env.TRUSTID_MEDIA_ROOT!, media.storageKey);
    expect(existsSync(file)).toBe(true);

    expect((await call("DELETE", `/v1/profile/documents/${doc.id}`, headers)).json()).toEqual({ deleted: true });
    expect(existsSync(file)).toBe(false);
    const after = await prisma.identityDocumentSubmission.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(after.mediaObjectId).toBeNull();
    expect((await prisma.identityMediaObject.findUniqueOrThrow({ where: { id: media.id } })).deletedAt).not.toBeNull();
    expect((await call("GET", "/v1/profile", headers)).json().documents).toEqual([]);
    expect((await call("DELETE", `/v1/profile/documents/${doc.id}`, headers)).statusCode).toBe(404);
  });

  it("never becomes verified automatically; only an allowed transition backed by authenticated provider evidence moves it", async () => {
    const { headers } = await withProfile();
    const doc = await submitDocument(headers);
    // Further profile activity does not touch the status.
    await call("PUT", "/v1/profile", headers, { givenName: "Adaeze", expectedVersion: 1 });
    await call("PUT", "/v1/profile/avatar", headers, { imageDataUrl: dataUrl("image/png", pngFixture()) });
    const status = async () => (await prisma.identityDocumentSubmission.findUniqueOrThrow({ where: { id: doc.id } })).verificationStatus;
    expect(await status()).toBe("UNVERIFIED");

    const evidence = (status: string) => ({ providerId: "test-kyc", providerReference: "ref-1", payload: { status }, signature: "valid" });
    // No provider is registered in V1.
    await expect(applyProviderDecision({ submissionId: doc.id, evidence: evidence("VERIFIED") })).rejects.toMatchObject({ code: "verification_provider_unavailable" });
    expect(await status()).toBe("UNVERIFIED");

    registerDocumentVerificationProvider({
      id: "test-kyc",
      async authenticateEvidence(e) {
        if (e.signature !== "valid") return null;
        return { providerReference: e.providerReference, status: (e.payload as { status: "PENDING" | "VERIFIED" }).status, evidenceDigest: "sha256:test" };
      },
    });
    await expect(applyProviderDecision({ submissionId: doc.id, evidence: { ...evidence("VERIFIED"), signature: "forged" } })).rejects.toMatchObject({ code: "invalid_provider_evidence" });
    await expect(applyProviderDecision({ submissionId: doc.id, evidence: evidence("VERIFIED") })).rejects.toMatchObject({ code: "invalid_status_transition" });
    expect(await status()).toBe("UNVERIFIED");

    await applyProviderDecision({ submissionId: doc.id, evidence: evidence("PENDING") });
    await expect(applyProviderDecision({ submissionId: doc.id, evidence: { ...evidence("VERIFIED"), providerReference: "ref-other" } })).rejects.toMatchObject({ code: "provider_reference_mismatch" });
    await applyProviderDecision({ submissionId: doc.id, evidence: evidence("VERIFIED") });
    expect(await status()).toBe("VERIFIED");
    const audit = await prisma.auditEvent.findMany({ where: { type: "identity_document.status_changed" }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => JSON.parse(a.metadata))).toMatchObject([
      { from: "UNVERIFIED", to: "PENDING", provider: "test-kyc" },
      { from: "PENDING", to: "VERIFIED", provider: "test-kyc" },
    ]);
    // A verified document still does not make self-declared names verified.
    expect((await call("GET", "/v1/profile/addressing", headers)).json().verification).toBe("SELF_DECLARED");
  });
});

describe("deletable storage even when DataZone is bound", () => {
  it("keeps profile pictures and documents in TrustID's encrypted store and deletes them for real", async () => {
    const original = getDataZoneClient();
    const sent: string[] = [];
    setDataZoneClient({
      bound: true,
      baseUrl: "https://datazone.example.test",
      async putObject(input) {
        sent.push(input.purpose);
        return { ok: true, data: { storageKey: "dz-key", contentHash: "x", byteSize: 1 }, via: "datazone" };
      },
      async getObjectBytes() {
        return { ok: false, error: "not_found", via: "datazone" };
      },
      async queueEnvelope() {
        return { ok: false, error: "unused", via: "datazone" };
      },
      async listInbox() {
        return { ok: false, error: "unused", via: "datazone" };
      },
    });
    try {
      const { headers } = await withProfile();
      const avatar = (await call("PUT", "/v1/profile/avatar", headers, { imageDataUrl: dataUrl("image/png", pngFixture()) })).json().profile;
      const doc = await submitDocument(headers);
      expect(sent).toEqual([]);
      const docRow = await prisma.identityDocumentSubmission.findUniqueOrThrow({ where: { id: doc.id } });
      const keys = await prisma.identityMediaObject.findMany({ where: { id: { in: [avatar.avatarAssetId, docRow.mediaObjectId!] } } });
      const files = keys.map((m) => path.join(process.env.TRUSTID_MEDIA_ROOT!, m.storageKey));
      expect(keys.every((m) => !m.storageKey.startsWith("datazone"))).toBe(true);
      expect(files.every((f) => existsSync(f))).toBe(true);
      await call("DELETE", "/v1/profile/avatar", headers);
      await call("DELETE", `/v1/profile/documents/${doc.id}`, headers);
      expect(files.some((f) => existsSync(f))).toBe(false);
    } finally {
      setDataZoneClient(original);
    }
  });
});

describe("Digi AI addressing interface", () => {
  it("returns the minimal profile of the token's subject when identity.addressing is granted", async () => {
    await registerDigiAiClient();
    const { user, headers } = await withProfile();
    await call("PUT", "/v1/profile/avatar", headers, { imageDataUrl: dataUrl("image/png", pngFixture()) });
    const tokens = await clientTokens(user.id, DIGI_AI, DIGI_AI.scopes);
    const res = await call("GET", "/v1/profile/addressing", { authorization: `Bearer ${tokens.access_token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["avatar", "name", "profileVersion", "sub", "verification"]);
    expect(body).toMatchObject({ sub: user.trustId, name: "Ada", verification: "SELF_DECLARED" });
    const link = new URL(body.avatar.url);
    const claims = link.searchParams.get("token")!.split(".");
    expect(claims[2]).toBe(DIGI_AI.clientId); // audience-bound to the requesting client
    expect((await call("GET", `${link.pathname.replace(/^\/api/, "")}${link.search}`)).statusCode).toBe(200);
  });

  it("denies retrieval without the scope, without authentication, or with a caller-chosen subject", async () => {
    await registerDigiAiClient();
    const ada = await withProfile("ada");
    const bob = await withProfile("bob");
    const basic = await clientTokens(ada.user.id, DIGI_AI, [SCOPES.OPENID, SCOPES.IDENTITY_BASIC]);
    expect((await call("GET", "/v1/profile/addressing", { authorization: `Bearer ${basic.access_token}` })).statusCode).toBe(403);
    expect((await call("GET", "/v1/profile/addressing")).statusCode).toBe(401);
    expect((await call("GET", "/v1/profile/addressing", { authorization: "Bearer not-a-token" })).statusCode).toBe(401);
    const full = await clientTokens(ada.user.id, DIGI_AI, DIGI_AI.scopes);
    for (const q of [`sub=${bob.user.trustId}`, "name=Bob", `trustId=${bob.user.trustId}`]) {
      const res = await call("GET", `/v1/profile/addressing?${q}`, { authorization: `Bearer ${full.access_token}` });
      expect(res.statusCode, q).toBe(400);
    }
    const own = await call("GET", "/v1/profile/addressing", { authorization: `Bearer ${full.access_token}` });
    expect(own.json().sub).toBe(ada.user.trustId);
  });

  it("serves a first-party session its own addressing profile", async () => {
    const { user, headers } = await withProfile();
    const res = await call("GET", "/v1/profile/addressing", headers);
    expect(res.json()).toMatchObject({ sub: user.trustId, name: "Ada", avatar: null });
  });
});

describe("OIDC profile scope and claim consent boundaries", () => {
  it("returns standard profile claims in userinfo only when profile was granted, never in the id_token", async () => {
    await registerDigiAiClient();
    const { user, headers } = await withProfile();
    await call("PUT", "/v1/profile/avatar", headers, { imageDataUrl: dataUrl("image/png", pngFixture()) });
    const granted = await clientTokens(user.id, DIGI_AI, [SCOPES.OPENID, SCOPES.PROFILE]);
    expect(granted.scope.split(" ")).toContain("profile");
    const info = (await call("GET", "/oauth/userinfo", { authorization: `Bearer ${granted.access_token}` })).json();
    expect(info).toMatchObject({
      sub: user.trustId,
      name: "Adaeze Okafor",
      given_name: "Adaeze",
      family_name: "Okafor",
      preferred_username: "Ada",
    });
    expect(info.picture).toMatch(/\/identity\/media\/.+\?token=/);
    expect(typeof info.updated_at).toBe("number");
    const idClaims = jose.decodeJwt(granted.id_token!);
    for (const claim of ["name", "given_name", "family_name", "preferred_username", "picture"]) {
      expect(idClaims[claim]).toBeUndefined();
    }

    const withoutProfile = await clientTokens(user.id, DIGI_AI, [SCOPES.OPENID, SCOPES.IDENTITY_BASIC]);
    const bare = (await call("GET", "/oauth/userinfo", { authorization: `Bearer ${withoutProfile.access_token}` })).json();
    for (const claim of ["name", "given_name", "family_name", "preferred_username", "picture"]) {
      expect(bare[claim]).toBeUndefined();
    }
  });

  it("does not change existing Portal clients: `openid profile` still grants no profile claims", async () => {
    await bootstrapPortalClients(() => undefined);
    const { user } = await withProfile();
    const tokens = await portalTokens(app, user.id, { scopes: [SCOPES.OPENID, SCOPES.PROFILE], nonce: "n-1" });
    expect(tokens.scope.split(" ")).not.toContain("profile");
    const info = (await call("GET", "/oauth/userinfo", { authorization: `Bearer ${tokens.access_token}` })).json();
    expect(info.sub).toBe(user.trustId);
    expect(info.name).toBeUndefined();
    expect(info.picture).toBeUndefined();
    const app_ = await prisma.application.findUniqueOrThrow({ where: { clientId: PORTAL.clientId } });
    expect(JSON.parse(app_.allowedScopes)).not.toContain("profile");
  });

  it("advertises the profile and addressing scopes and claims in discovery", async () => {
    const doc = (await call("GET", "/.well-known/openid-configuration")).json();
    expect(doc.scopes_supported).toEqual(expect.arrayContaining(["profile", "identity.addressing"]));
    expect(doc.claims_supported).toEqual(expect.arrayContaining(["name", "given_name", "family_name", "preferred_username", "picture"]));
    expect(doc.claims_supported).toEqual(expect.arrayContaining(["iss", "sub", "aud", "nonce", "auth_time"]));
  });
});

describe("no accidental production schema reset", () => {
  it("production start pushes the schema without reset or data-loss flags", () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const apiPkg = JSON.parse(readFileSync(path.join(repoRoot, "apps/api/package.json"), "utf8"));
    const startPath = [rootPkg.scripts.start, rootPkg.scripts["db:push:deploy"], apiPkg.scripts["db:push:deploy"]].join(" && ");
    expect(startPath).toMatch(/prisma db push/);
    expect(startPath).not.toMatch(/--force-reset|--accept-data-loss|migrate reset|db:push:reset/);
  });
});
