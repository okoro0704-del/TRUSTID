import { buildApp } from "./app.js";
import { config } from "./lib/config.js";
import { bootstrapPgVector } from "./lib/pgvector.js";

const app = await buildApp();

await bootstrapPgVector();

await app.listen({ port: config.port, host: config.host });
console.log(`TrustID API listening on http://localhost:${config.port}`);
