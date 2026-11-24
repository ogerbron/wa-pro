import { ObserverDB } from "./db.js";
import type { ObserverConfig } from "./types.js";

let config: ObserverConfig | undefined;
let pending: Promise<{ db: ObserverDB; config: ObserverConfig }> | undefined;
const cleanups = new Set<() => Promise<void>>();

export function registerObserverCleanup(cleanup: () => Promise<void>): () => void {
  cleanups.add(cleanup);
  return () => { cleanups.delete(cleanup); };
}

export function configureObserver(next: ObserverConfig): void {
  config = next;
}

export function getObserverConfig(): ObserverConfig | undefined {
  return config;
}

export async function ensureObserverState() {
  if (!config) throw new Error("Observer configuration is not initialized");
  const current = config;
  pending ??= ObserverDB.create(current.dbPath).then((db) => {
    db.migrateToScopedKeys();
    db.seedSettings(current);
    return { db, config: current };
  });
  const state = await pending;
  return { db: state.db, config: current };
}

export async function closeObserver(): Promise<void> {
  const state = pending;
  pending = undefined;
  await Promise.all([...cleanups].map(cleanup => cleanup()));
  if (state) (await state).db.close();
}
