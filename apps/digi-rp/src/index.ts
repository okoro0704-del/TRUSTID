import { composeDigiRuntime } from "./runtime.js";

const port = Number(process.env.PORT ?? 8795);
const { app, persistence } = await composeDigiRuntime();
await app.listen({ port, host: "0.0.0.0" });
console.log(`[digi-rp] listening on :${port} persistence=${persistence}`);
