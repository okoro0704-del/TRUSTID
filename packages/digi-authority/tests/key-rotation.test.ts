import { describe, expect, it } from "vitest";
import {
  AuthorityService,
  DIGITAL_TWIN_MRFUNDZMAN_POLICY,
  MemoryAuthorityStore,
  generateAuthoritySigningKey,
  mintAuthorityToken,
  actorKey,
} from "../src/index.js";
import { verifyAuthority } from "@trustid/authority-verifier";

describe("T4 key rotation", () => {
  it("accepts tokens from new kid after JWKS transition", async () => {
    const oldKey = await generateAuthoritySigningKey("auth-old");
    const newKey = await generateAuthoritySigningKey("auth-new");
    const resource = "elfcom:conversation:rot1";
    const { token: oldToken } = await mintAuthorityToken(oldKey, {
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
      jti: "j_old",
    });
    const { token: newToken } = await mintAuthorityToken(newKey, {
      ownerId: "o1",
      audience: "elfcom",
      actor: "digital_twin:mrfundzman",
      actions: ["message.send"],
      resources: [resource],
      limits: {},
      approval: "ALLOW",
      grantId: "g2",
      grantVersion: 1,
      oneTime: false,
      jti: "j_new",
    });

    const jwks = [oldKey.publicJwk, newKey.publicJwk];
    const vOld = await verifyAuthority({
      token: oldToken,
      audience: "elfcom",
      actor: actorKey({ type: "digital_twin", id: "mrfundzman" }),
      action: "message.send",
      resource,
      publicJwks: jwks,
    });
    const vNew = await verifyAuthority({
      token: newToken,
      audience: "elfcom",
      actor: actorKey({ type: "digital_twin", id: "mrfundzman" }),
      action: "message.send",
      resource,
      publicJwks: jwks,
    });
    expect(vOld.ok).toBe(true);
    expect(vNew.ok).toBe(true);

    // New-only JWKS rejects old kid
    const onlyNew = await verifyAuthority({
      token: oldToken,
      audience: "elfcom",
      actor: actorKey({ type: "digital_twin", id: "mrfundzman" }),
      action: "message.send",
      resource,
      publicJwks: [newKey.publicJwk],
    });
    expect(onlyNew.ok).toBe(false);
  });
});
