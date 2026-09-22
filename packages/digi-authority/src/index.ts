export * from "./types.js";
export * from "./stores.js";
export * from "./postgres-store.js";
export * from "./policy.js";
export * from "./tokens.js";
export * from "./service.js";

/** Lazy SQLite store — Node 22+ `node:sqlite`. Not loaded unless imported. */
export async function loadSqliteAuthorityStore() {
  const mod = await import("./sqlite-store.js");
  return mod;
}
export type { SqliteAuthorityStore } from "./sqlite-store.js";
