import pg from "pg";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
});

await client.connect();

const available = await client.query(
  "SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'vector'",
);
console.log("available:", JSON.stringify(available.rows));

const installed = await client.query(
  "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'",
);
console.log("installed:", JSON.stringify(installed.rows));

const tables = await client.query(
  "SELECT to_regclass('public.biometric_embeddings') AS biometric_embeddings",
);
console.log("tables:", JSON.stringify(tables.rows));

await client.end();
