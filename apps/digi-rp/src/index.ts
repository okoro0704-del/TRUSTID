import { buildDigiRp } from "./app.js";

const port = Number(process.env.PORT ?? 8795);

const { app } = await buildDigiRp({
  trustIdIssuer:
    process.env.TRUSTID_ISSUER?.trim() ||
    "https://trustedid.netlify.app/api",
  jwksUrl:
    process.env.TRUSTID_JWKS_URL?.trim() ||
    "https://trustedid.netlify.app/api/.well-known/jwks.json",
  digiAudience: process.env.DIGI_AUDIENCE?.trim(),
  cookieSecret: process.env.DIGI_COOKIE_SECRET,
});

await app.listen({ port, host: "0.0.0.0" });
console.log(`[digi-rp] listening on :${port}`);
