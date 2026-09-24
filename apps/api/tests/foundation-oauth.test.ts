import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { prisma } from "../src/db/client.js";
import { resetTables } from "./helpers/db.js";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";
import { registerApplication, createAuthorizationCode, exchangeAuthorizationCode, resolveAccessToken } from "../src/modules/authorization/service.js";
const verifier="test-only-pkce-verifier-with-at-least-43-characters";
describe("OAuth PKCE security regression",()=>{
  beforeEach(async()=>resetTables(prisma)); afterAll(async()=>prisma.$disconnect());
  async function fixture(){const user=await createZeroPiiUser("oauth-fixture@example.invalid");
    const app=await registerApplication({name:"test RP",redirectUris:["https://rp.invalid/callback"],allowedScopes:["openid"]});
    const input={userId:user.id,clientId:app.clientId,redirectUri:"https://rp.invalid/callback",scopes:["openid"],codeChallenge:createHash("sha256").update(verifier).digest("base64url"),codeChallengeMethod:"S256"};
    const {code}=await createAuthorizationCode(input);return{...input,code,codeVerifier:verifier};}
  it("accepts correct PKCE once and rejects replay",async()=>{const f=await fixture();const result=await exchangeAuthorizationCode(f);expect(await resolveAccessToken(result.access_token)).toMatchObject({userId:f.userId});await expect(exchangeAuthorizationCode(f)).rejects.toThrow("invalid_grant");});
  it("rejects wrong verifier and redirect",async()=>{const f=await fixture();await expect(exchangeAuthorizationCode({...f,codeVerifier:"wrong"})).rejects.toThrow("invalid_grant");await expect(exchangeAuthorizationCode({...f,redirectUri:"https://evil.invalid/callback"})).rejects.toThrow("invalid_grant");await expect(createAuthorizationCode({...f,redirectUri:"https://evil.invalid"})).rejects.toThrow("invalid_redirect_uri");});
  it("concurrent exchanges cannot mint twice from one authorization code",async()=>{const f=await fixture();const results=await Promise.allSettled([exchangeAuthorizationCode(f),exchangeAuthorizationCode(f)]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);});
});
