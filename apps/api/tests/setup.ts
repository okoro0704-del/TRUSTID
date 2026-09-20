import { setupTestDatabase } from "./helpers/db.js";

/** Local Vitest only: bounded exact Top-K when pgvector is unavailable (SQLite). */
process.env.TRUSTID_SQLITE_ANN = "1";

setupTestDatabase();
