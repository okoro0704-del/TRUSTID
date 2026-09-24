import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDigiRp } from "../src/app.js";
import { loadAuthoritySigningKey } from "../src/keys.js";
const options={trustIdIssuer:"https://test.invalid",jwksUrl:"https://test.invalid/jwks"};
afterEach(()=>vi.unstubAllEnvs());
describe("Digi production fail-closed defaults",()=>{
  it("requires a production cookie secret",async()=>{
    vi.stubEnv("NODE_ENV","production");await expect(buildDigiRp(options)).rejects.toThrow(/DIGI_COOKIE_SECRET/);
  });
  it("does not silently use ephemeral owner/replay/session stores in production",async()=>{
    vi.stubEnv("NODE_ENV","production");await expect(buildDigiRp({...options,cookieSecret:"test-only-strong-cookie-secret-32-chars"})).rejects.toThrow(/durable owner/);
  });
  it("does not generate ephemeral production signing keys",async()=>{
    vi.stubEnv("NODE_ENV","production");vi.stubEnv("DIGI_AUTHORITY_PRIVATE_JWK","");await expect(loadAuthoritySigningKey()).rejects.toThrow(/required/);
  });
  it("rejects wrong key type rather than publishing private symmetric key material",async()=>{
    vi.stubEnv("DIGI_AUTHORITY_PRIVATE_JWK",JSON.stringify({kty:"oct",k:"test"}));await expect(loadAuthoritySigningKey()).rejects.toThrow(/Ed25519/);
  });
  it("permits configured browser origins and rejects arbitrary origins",async()=>{
    const {app}=await buildDigiRp({...options,corsOrigins:["https://trustedid.netlify.app"]});
    try{const good=await app.inject({url:"/health",headers:{origin:"https://trustedid.netlify.app"}});expect(good.headers["access-control-allow-origin"]).toBe("https://trustedid.netlify.app");
      const bad=await app.inject({url:"/health",headers:{origin:"https://evil.invalid"}});expect(bad.statusCode).toBe(403);expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    }finally{await app.close();}
  });
});
