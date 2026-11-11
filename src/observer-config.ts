import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { join } from "node:path";
import type { WhatsAppProChannelConfig } from "./channel-config.js";
import { DEFAULT_OBSERVER_MODE, OBSERVER_MODES, type ObserverConfig, type ObserverMode, type ObserverSettings } from "./observer/types.js";

const DEFAULT_DB_PATH = "~/.openclaw/whatsapp-observer/messages.db";
const DEFAULT_MEDIA_PATH = "~/.openclaw/whatsapp-observer/media";

/**
 * Parse observer config from openclaw.json.
 *
 * Paths and observer account list come from openclaw.json.
 * Mode/filters/retention are also parsed here for migration seeding,
 * but at runtime the DB's settings table is the source of truth.
 */
export function parseObserverConfig(
  channelConfig: WhatsAppProChannelConfig | undefined,
): ObserverConfig {
  const raw = channelConfig?.observer;

  const dbPath = typeof raw?.dbPath === "string" ? raw.dbPath : process.env.OPENCLAW_STATE_DIR ? join(process.env.OPENCLAW_STATE_DIR, "whatsapp-observer", "messages.db") : DEFAULT_DB_PATH;
  const mediaPath = typeof raw?.mediaPath === "string" ? raw.mediaPath : process.env.OPENCLAW_STATE_DIR ? join(process.env.OPENCLAW_STATE_DIR, "whatsapp-observer", "media") : DEFAULT_MEDIA_PATH;

  // Observer account IDs
  const observerAccounts = Array.isArray(raw?.accounts) ? raw.accounts : [];

  // Settings (used for migration seeding — at runtime, DB is source of truth)
  const settings = parseObserverSettingsFromConfig(raw);

  return { dbPath, mediaPath, observerAccounts, ...settings };
}

/**
 * Parse settings fields from the openclaw.json observer block.
 * Used to seed the DB on first run (migration from config to DB).
 */
export function parseObserverSettingsFromConfig(
  raw: Record<string, unknown> | undefined,
): ObserverSettings {
  const rawMode = typeof raw?.mode === "string" ? raw.mode : undefined;
  const mode: ObserverMode = rawMode && (OBSERVER_MODES as readonly string[]).includes(rawMode)
    ? (rawMode as ObserverMode)
    : DEFAULT_OBSERVER_MODE;

  const rawFilters = raw?.filters as Record<string, unknown> | undefined;
  const blocklist = Array.isArray(rawFilters?.blocklist) ? rawFilters.blocklist as string[] : [];
  const allowlist = Array.isArray(rawFilters?.allowlist) ? rawFilters.allowlist as string[] : ["*"];

  const retentionDays =
    typeof raw?.retentionDays === "number" ? raw.retentionDays : 90;

  return { mode, filters: { blocklist, allowlist }, retentionDays };
}

export function isObserverAccount(accountId: string, config: { observerAccounts: string[] }): boolean {
  const normalized = normalizeAccountId(accountId);
  return config.observerAccounts.some(id => normalizeAccountId(id) === normalized);
}
