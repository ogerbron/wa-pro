import JSON5 from "json5";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ObserverFilters, ObserverMode } from "../../../src/observer/types.js";
import { OBSERVER_MODES, DEFAULT_OBSERVER_MODE } from "../../../src/observer/types.js";

export type ResolvedObserverConfig = {
  mode: ObserverMode;
  filters: ObserverFilters;
  dbPath: string;
};

const DEFAULT_CONFIG_PATH = join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"), "openclaw.json");
const DEFAULT_DB_PATH = join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"), "whatsapp-observer", "messages.db");

/**
 * Reads the openclaw config file and extracts observer settings.
 * Falls back to safe defaults if the file is missing or malformed.
 */
export function readObserverConfig(configPath?: string): ResolvedObserverConfig {
  const filePath = configPath ?? process.env.OPENCLAW_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;

  let config: Record<string, unknown>;
  try {
    const raw = readFileSync(filePath, "utf-8");
    config = JSON5.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      mode: DEFAULT_OBSERVER_MODE,
      filters: { blocklist: [], allowlist: ["*"] },
      dbPath: DEFAULT_DB_PATH,
    };
  }

  const channels = config.channels as Record<string, unknown> | undefined;
  const whatsappPro = channels?.["whatsapp-pro"] as Record<string, unknown> | undefined;
  const observer = whatsappPro?.observer as Record<string, unknown> | undefined;

  const rawMode = typeof observer?.mode === "string" ? observer.mode : undefined;
  const mode: ObserverMode =
    rawMode && (OBSERVER_MODES as readonly string[]).includes(rawMode)
      ? (rawMode as ObserverMode)
      : DEFAULT_OBSERVER_MODE;

  const rawFilters = observer?.filters as Record<string, unknown> | undefined;
  const blocklist = Array.isArray(rawFilters?.blocklist)
    ? (rawFilters.blocklist as string[])
    : [];
  const allowlist = Array.isArray(rawFilters?.allowlist)
    ? (rawFilters.allowlist as string[])
    : ["*"];

  const dbPath =
    typeof observer?.dbPath === "string" ? resolveHomePath(observer.dbPath) : DEFAULT_DB_PATH;

  return { mode, filters: { blocklist, allowlist }, dbPath };
}

function resolveHomePath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}
