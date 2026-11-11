import JSON5 from "json5";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ObserverDB } from "../../../src/observer/db.js";

export type AccountInfo = {
  accountId: string;
  name?: string;
  enabled: boolean;
  role: "observer" | "normal";
  linked: boolean;
  authDir: string;
  dmPolicy?: string;
  groupPolicy?: string;
  allowFrom: string[];
  groupAllowFrom: string[];
  groups: string[];
  lastMessageAt: number | null;
  messageCount: number;
};

type RawAccountConfig = {
  name?: string;
  enabled?: boolean;
  observer?: boolean;
  authDir?: string;
  dmPolicy?: string;
  groupPolicy?: string;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groups?: Record<string, unknown>;
};

const DEFAULT_CONFIG_PATH = join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"), "openclaw.json");
// Try both known credential paths — the SDK's resolveOAuthDir() may return either
const CREDENTIAL_DIRS = [
  join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"), "credentials", "whatsapp"),
  join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"), "oauth", "whatsapp"),
];

/**
 * Read all configured accounts from openclaw.json and enrich with
 * credential status and DB stats.
 */
export function readAccounts(
  db: ObserverDB | undefined,
  configPath?: string,
): AccountInfo[] {
  const filePath = configPath ?? process.env.OPENCLAW_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;

  let config: Record<string, unknown>;
  try {
    config = JSON5.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return [];
  }

  const channels = config.channels as Record<string, unknown> | undefined;
  const whatsappPro = channels?.["whatsapp-pro"] as Record<string, unknown> | undefined;
  const rawAccounts = whatsappPro?.accounts as Record<string, RawAccountConfig> | undefined;

  if (!rawAccounts || typeof rawAccounts !== "object") {
    return [];
  }

  // Observer account IDs from the observer.accounts array (legacy) or per-account observer flag
  const observerSection = whatsappPro?.observer as Record<string, unknown> | undefined;
  const observerAccountIds = new Set<string>(
    Array.isArray(observerSection?.accounts) ? observerSection.accounts as string[] : [],
  );

  const results: AccountInfo[] = [];

  for (const [accountId, raw] of Object.entries(rawAccounts)) {
    if (!raw || typeof raw !== "object") continue;

    const isObserver = raw.observer === true || observerAccountIds.has(accountId);
    const authDir = resolveAuthDir(accountId, raw.authDir);
    const linked = hasCredentials(authDir);

    let lastMessageAt: number | null = null;
    let messageCount = 0;
    if (db) {
      const stats = db.getStats({ accountId });
      lastMessageAt = stats.lastMessageAt;
      messageCount = stats.totalMessages;
    }

    results.push({
      accountId,
      name: raw.name,
      enabled: raw.enabled !== false,
      role: isObserver ? "observer" : "normal",
      linked,
      authDir,
      dmPolicy: raw.dmPolicy,
      groupPolicy: raw.groupPolicy,
      allowFrom: Array.isArray(raw.allowFrom) ? raw.allowFrom : [],
      groupAllowFrom: Array.isArray(raw.groupAllowFrom) ? raw.groupAllowFrom : [],
      groups: raw.groups ? Object.keys(raw.groups) : [],
      lastMessageAt,
      messageCount,
    });
  }

  return results;
}

function resolveAuthDir(accountId: string, configuredAuthDir?: string): string {
  if (configuredAuthDir) {
    return configuredAuthDir.startsWith("~/")
      ? join(homedir(), configuredAuthDir.slice(2))
      : configuredAuthDir;
  }
  // Check known credential paths, return first that exists
  for (const dir of CREDENTIAL_DIRS) {
    const candidate = join(dir, accountId);
    if (existsSync(join(candidate, "creds.json"))) {
      return candidate;
    }
  }
  // Default to first path
  return join(CREDENTIAL_DIRS[0], accountId);
}

function hasCredentials(authDir: string): boolean {
  try {
    const credsPath = join(authDir, "creds.json");
    if (!existsSync(credsPath)) return false;
    const stat = readFileSync(credsPath);
    return stat.length > 1;
  } catch {
    return false;
  }
}
