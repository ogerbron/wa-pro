import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ObserverDB } from "../../../src/observer/db.js";
import { readObserverConfig } from "./config-reader.js";

const DEFAULT_DB_PATH = join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"), "whatsapp-observer", "messages.db");

/**
 * Resolves the DB path from (in priority order):
 * 1. Explicit `--db` flag
 * 2. `WA_PRO_DB` environment variable
 * 3. openclaw.json config
 * 4. Default path
 */
export function resolveDbPath(flagValue: string | undefined): string {
  if (flagValue) return resolveHomePath(flagValue);
  if (process.env.WA_PRO_DB) return resolveHomePath(process.env.WA_PRO_DB);

  const config = readObserverConfig();
  if (config.dbPath) return config.dbPath;

  return DEFAULT_DB_PATH;
}

/**
 * Opens the shared observer SQLite database.
 * Throws a user-friendly error if the DB file doesn't exist.
 */
export async function openDb(dbPath: string): Promise<ObserverDB> {
  if (!existsSync(dbPath)) {
    throw new Error(
      `Observer database not found at ${dbPath}\n` +
        "Make sure the WhatsApp Pro plugin is running and has recorded messages.\n" +
        "You can specify a different path with --db or WA_PRO_DB env var.",
    );
  }
  const db = await ObserverDB.create(dbPath);
  // Ensure legacy unscoped keys are migrated to global.* prefix
  db.migrateToScopedKeys();
  return db;
}

function resolveHomePath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}
