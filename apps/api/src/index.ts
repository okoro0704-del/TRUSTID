import { buildApp } from "./app.js";
import { config } from "./lib/config.js";

const app = await buildApp();

await app.listen({ port: config.port, host: config.host });
console.log(`TrustID API listening on http://localhost:${config.port}`);
