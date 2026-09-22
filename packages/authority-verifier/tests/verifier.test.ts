import { describe, expect, it } from "vitest";
import {
  DIGI_AUTHORITY_ISSUER,
  elfComConversationResource,
  parseElfComResource,
  verifyAuthority,
} from "../src/index.js";
import {
  generateAuthoritySigningKey,
  mintAuthorityToken,
} from "../../digi-authority/src/tokens.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

describe("authority-verifier", () => {
  it("parses ElfCom resources exactly", () => {
    expect(parseElfComResource("elfcom:conversation:abc")).toEqual({
      kind: "conversation",
      conversationId: "abc",
    });
    expect(parseElfComResource("elfcom:recipient:tid_1")).toEqual({
      kind: "recipient",
      trustId: "tid_1",
    });
    expect(parseElfComResource("elfcom:*")).toBeNull();
    expect(parseElfComResource("elfcom:conversation:abc:extra")).toBeNull();
  });

  it("accepts valid Digi authority token", async () => {
    const key = await generateAuthoritySigningKey("v1");
    const resource = elfComConversationResource("c1");
    const { token } = await mintAuthorityToken(key, {
      ownerId: "digi_owner_1",
      audience: "elfcom",
      actor: "digital_twin:mrfundzman",
      actions: ["message.send"],
      resources: [resource],
      limits: { maxMessages: 10 },
      approval: "ALLOW_WITH_LIMITS",
      grantId: "auth_1",
      grantVersion: 1,
      oneTime: false,
      jti: "jti_ok",
    });
    const v = await verifyAuthority({
      token,
      audience: "elfcom",
      actor: "digital_twin:mrfundzman",
      action: "message.send",
      resource,
      publicJwks: [key.publicJwk],
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.claims.iss).toBe(DIGI_AUTHORITY_ISSUER);
  });

  it("rejects wrong audience / action / resource / actor", async () => {
    const key = await generateAuthoritySigningKey("v2");
    const resource = elfComConversationResource("A");
    const { token } = await mintAuthorityToken(key, {
      ownerId: "o1",
      audience: "elfcom",
      actor: "digital_twin:mrfundzman",
      actions: ["message.send"],
      resources: [resource],
      limits: {},
      approval: "ALLOW",
      grantId: "g1",
      grantVersion: 1,
      oneTime: false,
      jti: "j1",
    });
    const jwks = [key.publicJwk];
    expect(
      (
        await verifyAuthority({
          token,
          audience: "tv",
          actor: "digital_twin:mrfundzman",
          action: "message.send",
          resource,
          publicJwks: jwks,
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await verifyAuthority({
          token,
          audience: "elfcom",
          actor: "digital_twin:mrfundzman",
          action: "message.read",
          resource,
          publicJwks: jwks,
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await verifyAuthority({
          token,
          audience: "elfcom",
          actor: "digital_twin:mrfundzman",
          action: "message.send",
          resource: elfComConversationResource("B"),
          publicJwks: jwks,
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await verifyAuthority({
          token,
          audience: "elfcom",
          actor: "service:unknown",
          action: "message.send",
          resource,
          publicJwks: jwks,
        })
      ).ok
    ).toBe(false);
  });

  it("rejects TrustID-shaped identity assertion as authority", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "tid";
    publicJwk.alg = "EdDSA";
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: "tid" })
      .setIssuer("https://trustedid.netlify.app/api")
      .setAudience("digiconomy:digi")
      .setSubject("user_1")
      .setExpirationTime("60s")
      .setJti("id_jti")
      .sign(privateKey);
    const v = await verifyAuthority({
      token,
      audience: "elfcom",
      actor: "digital_twin:x",
      action: "message.send",
      resource: elfComConversationResource("c"),
      publicJwks: [publicJwk],
    });
    expect(v.ok).toBe(false);
  });

  it("rejects alg=none and missing token", async () => {
    const none = [
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url"),
      "",
    ].join(".");
    expect(
      (
        await verifyAuthority({
          token: none,
          audience: "elfcom",
          actor: "a:b",
          action: "message.send",
          resource: "elfcom:conversation:1",
          publicJwks: [],
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await verifyAuthority({
          token: "",
          audience: "elfcom",
          actor: "a:b",
          action: "message.send",
          resource: "elfcom:conversation:1",
        })
      ).reason
    ).toBe("missing_token");
  });
});
