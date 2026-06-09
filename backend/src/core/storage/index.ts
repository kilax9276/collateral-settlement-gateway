import type { AppConfig } from "../../config.js";
import type { AppStorage } from "./types.js";
import { MemoryStorage } from "./memoryStore.js";
import { SqliteStorage } from "./sqliteStore.js";

export function createStorage(appConfig: AppConfig): AppStorage {
  if (appConfig.storageDriver === "memory") return new MemoryStorage();
  return new SqliteStorage(appConfig.sqlitePath);
}

export { MemoryStorage } from "./memoryStore.js";
export { SqliteStorage } from "./sqliteStore.js";
export type { AppStorage, StoredBalance, StoredSignedIntent } from "./types.js";
