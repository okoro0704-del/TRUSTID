import { AUDIT_EVENTS, DEFAULT_APP_SCOPES, SCOPES } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { hashSecret, randomToken, sha256Base64Url } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";

function parseJsonArray(raw: string): string[] {
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

export async function listApplications(userId?: string) {
  const apps = await prisma.application.findMany({
    where: { status: "active" },
    orderBy: { name: "asc" },
  });

  let authMap = new Map<string, { id: string; scopes: string[] }>();
  if (userId) {
    const auths = await prisma.authorization.findMany({
      where: { userId, status: "active" },
      include: { scopes: true },
    });
    authMap = new Map(
      auths.map((a) => [
        a.applicationId,
        { id: a.id, scopes: a.scopes.map((s) => s.scope) },
      ]),
    );
  }

  return apps.map((app) => {
    const auth = authMap.get(app.id);
    return {
      id: app.id,
      clientId: app.clientId,
      name: app.name,
      type: app.type,
      allowedScopes: parseJsonArray(app.allowedScopes),
      connected: Boolean(auth),
      authorizationId: auth?.id ?? null,
      grantedScopes: auth?.scopes ?? [],
    };
  });
}

export async function registerApplication(input: {
  name: string;
  type?: "public" | "confidential";
  redirectUris: string[];
  allowedScopes?: string[];
}) {
  const clientId = `tid_${randomToken(12)}`;
  const clientSecret = input.type === "confidential" ? randomToken(24) : null;
  const app = await prisma.application.create({
    data: {
      name: input.name,
      type: input.type ?? "public",
      clientId,
      clientSecretHash: clientSecret ? hashSecret(clientSecret) : null,
      redirectUris: JSON.stringify(input.redirectUris),
      allowedScopes: JSON.stringify(input.allowedScopes ?? DEFAULT_APP_SCOPES),
    },
  });
  return {
    id: app.id,
    clientId: app.clientId,
    clientSecret,
    name: app.name,
    redirectUris: input.redirectUris,
    allowedScopes: parseJsonArray(app.allowedScopes),
  };
}

export async function listAuthorizations(userId: string) {
  const rows = await prisma.authorization.findMany({
    where: { userId, status: "active" },
    include: { application: true, scopes: true },
    orderBy: { grantedAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    application: {
      id: r.application.id,
      name: r.application.name,
      clientId: r.application.clientId,
    },
    scopes: r.scopes.map((s) => s.scope),
    grantedAt: r.grantedAt.toISOString(),
  }));
}

export async function grantAuthorization(input: {
  userId: string;
  applicationId: string;
  scopes: string[];
  ip?: string;
  userAgent?: string;
}) {
  const app = await prisma.application.findUnique({
    where: { id: input.applicationId },
  });
  if (!app || app.status !== "active") {
    throw Object.assign(new Error("Application not found"), { statusCode: 404 });
  }
  const allowed = new Set(parseJsonArray(app.allowedScopes));
  const scopes = [...new Set(input.scopes)].filter((s) => allowed.has(s));
  if (!scopes.length) {
    throw Object.assign(new Error("No valid scopes"), { statusCode: 400 });
  }

  const existing = await prisma.authorization.findFirst({
    where: { userId: input.userId, applicationId: app.id, status: "active" },
  });
  if (existing) {
    await prisma.authorizationScope.deleteMany({
      where: { authorizationId: existing.id },
    });
    await prisma.authorizationScope.createMany({
      data: scopes.map((scope) => ({ authorizationId: existing.id, scope })),
    });
    await recordAudit({
      type: AUDIT_EVENTS.PERMISSION_GRANTED,
      userId: input.userId,
      actorType: "user",
      actorId: input.userId,
      metadata: { authorizationId: existing.id, scopes },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return existing.id;
  }

  const auth = await prisma.authorization.create({
    data: {
      userId: input.userId,
      applicationId: app.id,
      status: "active",
      scopes: { create: scopes.map((scope) => ({ scope })) },
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.APPLICATION_AUTHORIZED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: { authorizationId: auth.id, applicationId: app.id, scopes },
    ip: input.ip,
    userAgent: input.userAgent,
  });
  await recordAudit({
    type: AUDIT_EVENTS.PERMISSION_GRANTED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: { authorizationId: auth.id, scopes },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return auth.id;
}

export async function revokeAuthorization(
  userId: string,
  authorizationId: string,
  meta?: { ip?: string; userAgent?: string },
) {
  const auth = await prisma.authorization.findFirst({
    where: { id: authorizationId, userId },
  });
  if (!auth) {
    throw Object.assign(new Error("Authorization not found"), { statusCode: 404 });
  }
  if (auth.status === "revoked") return;

  await prisma.$transaction([
    prisma.authorization.update({
      where: { id: authorizationId },
      data: { status: "revoked", revokedAt: new Date() },
    }),
    prisma.oAuthAccessToken.updateMany({
      where: {
        userId,
        applicationId: auth.applicationId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    }),
    prisma.oAuthRefreshToken.updateMany({
      where: {
        userId,
        applicationId: auth.applicationId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    }),
  ]);

  await recordAudit({
    type: AUDIT_EVENTS.APPLICATION_REVOKED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { authorizationId, applicationId: auth.applicationId },
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
  await recordAudit({
    type: AUDIT_EVENTS.PERMISSION_REVOKED,
    userId,
    actorType: "user",
    actorId: userId,
    metadata: { authorizationId },
    ip: meta?.ip,
    userAgent: meta?.userAgent,
  });
}

export async function createAuthorizationCode(input: {
  userId: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
}) {
  const app = await prisma.application.findUnique({
    where: { clientId: input.clientId },
  });
  if (!app || app.status !== "active") {
    throw Object.assign(new Error("invalid_client"), { statusCode: 400 });
  }
  const redirects = parseJsonArray(app.redirectUris);
  if (!redirects.includes(input.redirectUri)) {
    throw Object.assign(new Error("invalid_redirect_uri"), { statusCode: 400 });
  }
  const allowed = new Set(parseJsonArray(app.allowedScopes));
  const scopes = input.scopes.filter((s) => allowed.has(s));
  if (!scopes.includes(SCOPES.OPENID) && allowed.has(SCOPES.OPENID)) {
    scopes.push(SCOPES.OPENID);
  }

  await grantAuthorization({
    userId: input.userId,
    applicationId: app.id,
    scopes,
  });

  const code = randomToken(32);
  await prisma.oAuthAuthorizationCode.create({
    data: {
      codeHash: hashSecret(code),
      userId: input.userId,
      applicationId: app.id,
      redirectUri: input.redirectUri,
      scopes: JSON.stringify(scopes),
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
  return { code, scopes, application: app };
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  clientSecret?: string;
}) {
  const app = await prisma.application.findUnique({
    where: { clientId: input.clientId },
  });
  if (!app || app.status !== "active") {
    throw Object.assign(new Error("invalid_client"), { statusCode: 401 });
  }
  if (app.type === "confidential") {
    if (!input.clientSecret || hashSecret(input.clientSecret) !== app.clientSecretHash) {
      throw Object.assign(new Error("invalid_client"), { statusCode: 401 });
    }
  }

  const row = await prisma.oAuthAuthorizationCode.findUnique({
    where: { codeHash: hashSecret(input.code) },
  });
  if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) {
    throw Object.assign(new Error("invalid_grant"), { statusCode: 400 });
  }
  if (row.applicationId !== app.id || row.redirectUri !== input.redirectUri) {
    throw Object.assign(new Error("invalid_grant"), { statusCode: 400 });
  }
  if (row.codeChallengeMethod !== "S256") {
    throw Object.assign(new Error("invalid_request"), { statusCode: 400 });
  }
  if (sha256Base64Url(input.codeVerifier) !== row.codeChallenge) {
    throw Object.assign(new Error("invalid_grant"), { statusCode: 400 });
  }

  await prisma.oAuthAuthorizationCode.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });

  const scopes = parseJsonArray(row.scopes);
  const accessToken = randomToken(32);
  await prisma.oAuthAccessToken.create({
    data: {
      tokenHash: hashSecret(accessToken),
      userId: row.userId,
      applicationId: app.id,
      scopes: JSON.stringify(scopes),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  let refreshToken: string | undefined;
  if (scopes.includes(SCOPES.OFFLINE_ACCESS)) {
    refreshToken = randomToken(32);
    await prisma.oAuthRefreshToken.create({
      data: {
        tokenHash: hashSecret(refreshToken),
        userId: row.userId,
        applicationId: app.id,
        scopes: JSON.stringify(scopes),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
  }

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: scopes.join(" "),
    refresh_token: refreshToken,
  };
}

export async function resolveAccessToken(token: string) {
  const row = await prisma.oAuthAccessToken.findUnique({
    where: { tokenHash: hashSecret(token) },
    include: { user: true, application: true },
  });
  if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) return null;
  return {
    userId: row.userId,
    applicationId: row.applicationId,
    scopes: parseJsonArray(row.scopes),
    trustId: row.user.trustId,
  };
}

export function parseScopeParam(scope?: string | null): string[] {
  if (!scope) return [...DEFAULT_APP_SCOPES];
  return scope.split(/[\s+]+/).filter(Boolean);
}
