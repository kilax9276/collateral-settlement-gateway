import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const files = [
  resolve(process.cwd(), "backend/data/app.db"),
  resolve(process.cwd(), "backend/data/app.db-shm"),
  resolve(process.cwd(), "backend/data/app.db-wal"),
  resolve(process.cwd(), "backend/data/demo-e2e.db"),
  resolve(process.cwd(), "backend/data/demo-e2e.db-shm"),
  resolve(process.cwd(), "backend/data/demo-e2e.db-wal"),
];

await Promise.all(files.map((file) => rm(file, { force: true })));
console.log("Removed local SQLite demo databases from backend/data/.");
