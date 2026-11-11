import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { isAllowed, isBlocked } from "./filter.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ConversationSummary,
  ObserverFilters,
  ObserverMessage,
  ObserverMode,
  ObserverSettings,
  ObserverStats,
  StatsGroupByResult,
} from "./types.js";
import { DEFAULT_OBSERVER_MODE, OBSERVER_MODES } from "./types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  from_me INTEGER NOT NULL DEFAULT 0,
  account_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  sender_name TEXT,
  sender_e164 TEXT,
  conversation_id TEXT NOT NULL,
  is_group INTEGER NOT NULL DEFAULT 0,
  group_id TEXT,
  group_name TEXT,
  content TEXT,
  media_type TEXT,
  media_path TEXT,
  media_mime TEXT,
  message_type TEXT NOT NULL DEFAULT 'message',
  ref_message_id TEXT,
  source TEXT NOT NULL DEFAULT 'observer',
  timestamp INTEGER NOT NULL,
  logged_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(message_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id);
CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT NOT NULL,
  account_id TEXT NOT NULL,
  phone TEXT,
  push_name TEXT,
  business_name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  group_subject TEXT,
  group_description TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (jid, account_id)
);

CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
`;

const MIGRATION_COLUMNS = [
  "ALTER TABLE messages ADD COLUMN from_me INTEGER NOT NULL DEFAULT 0;",
  "ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'message';",
  "ALTER TABLE messages ADD COLUMN ref_message_id TEXT;",
  "ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'observer';",
];

const FTS_SETUP = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, sender_name, group_name,
    content='messages', content_rowid='id'
  );`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, sender_name, group_name)
    VALUES (new.id, new.content, new.sender_name, new.group_name);
  END;`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, sender_name, group_name)
    VALUES ('delete', old.id, old.content, old.sender_name, old.group_name);
  END;`,
  `CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, sender_name, group_name)
    VALUES ('delete', old.id, old.content, old.sender_name, old.group_name);
    INSERT INTO messages_fts(rowid, content, sender_name, group_name)
    VALUES (new.id, new.content, new.sender_name, new.group_name);
  END;`,
];

const INSERT_SQL = `
INSERT OR IGNORE INTO messages (
  message_id, from_me, account_id, sender, sender_name, sender_e164,
  conversation_id, is_group, group_id, group_name,
  content, media_type, media_path, media_mime, timestamp,
  message_type, ref_message_id, source, logged_at
) VALUES (
  :messageId, :fromMe, :accountId, :sender, :senderName, :senderE164,
  :conversationId, :isGroup, :groupId, :groupName,
  :content, :mediaType, :mediaPath, :mediaMime, :timestamp,
  :messageType, :refMessageId, :source, :loggedAt
)`;

export class ObserverDB {
  private db: DatabaseSync;
  private visibilitySettings = new Map<string, ObserverSettings>();
  private queryDepth = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.init();
    this.db.function("observer_visible", (accountId, e164, sender, conversationId) => {
      const id = String(accountId);
      let settings = this.visibilitySettings.get(id);
      if (!settings) {
        settings = this.getAccountSettings(id);
        this.visibilitySettings.set(id, settings);
      }
      if (settings.mode === "record-all-retrieve-all") return 1;
      const identity = String(e164 ?? sender);
      return !isBlocked(identity, String(conversationId), settings.filters) &&
        isAllowed(identity, String(conversationId), settings.filters) ? 1 : 0;
    });
    this.db.exec(`CREATE TEMP VIEW visible_messages AS SELECT * FROM messages
      WHERE observer_visible(account_id, sender_e164, sender, conversation_id) = 1`);
  }

  static async create(dbPath: string): Promise<ObserverDB> {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    try {
      return new ObserverDB(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private run(sql: string, binds: Record<string, unknown> = {}): void {
    this.db.prepare(sql).run(binds as Record<string, SQLInputValue>);
  }

  private ftsEnabled = false;

  private init(): void {
    this.run("PRAGMA journal_mode = WAL;");
    this.run("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
    const contactColumns = this.query("PRAGMA table_info(contacts)");
    if (!contactColumns.some((column) => column.name === "account_id" && Number(column.pk) > 0)) {
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE contacts RENAME TO contacts_legacy;
        ${SCHEMA_SQL}
        INSERT INTO contacts SELECT * FROM contacts_legacy;
        DROP TABLE contacts_legacy;
        CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
        CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
        COMMIT;`);
    }
    for (const stmt of MIGRATION_COLUMNS) {
      try {
        this.run(stmt);
      } catch {
        // Column already exists
      }
    }
    const hadFts = this.query("SELECT name FROM sqlite_master WHERE name = 'messages_fts'").length > 0;
    // Build the index for existing sql.js databases on first native SQLite open.
    for (const stmt of FTS_SETUP) {
      try {
        this.run(stmt);
        this.ftsEnabled = true;
      } catch {
        this.ftsEnabled = false;
        break;
      }
    }
    if (this.ftsEnabled && !hadFts) this.run("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
  }

  // ── Settings ──────────────────────────────────────────────────────
  //
  // Keys are scoped: "global.<key>" for defaults, "account.<id>.<key>" for overrides.
  // Resolution: account.<id>.<key> ?? global.<key> ?? hardcoded default.

  getSetting(key: string): string | undefined {
    const rows = this.query("SELECT value FROM settings WHERE key = :key", { ":key": key });
    return rows.length > 0 ? String(rows[0].value) : undefined;
  }

  setSetting(key: string, value: string): void {
    this.run(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (:key, :value)",
      { ":key": key, ":value": value },
    );
  }

  deleteSetting(key: string): void {
    this.run("DELETE FROM settings WHERE key = :key", { ":key": key });
  }

  // ── Scoped settings helpers ──────────────────────────────────────

  private resolveSettingKey(scope: string, key: string): string {
    return `${scope}.${key}`;
  }

  /** Get a setting, resolving account → global → undefined. */
  getScoped(accountId: string | undefined, key: string): string | undefined {
    if (accountId) {
      const accountVal = this.getSetting(this.resolveSettingKey(`account.${accountId}`, key));
      if (accountVal !== undefined) return accountVal;
    }
    return this.getSetting(this.resolveSettingKey("global", key));
  }

  /** Set a global setting. */
  setGlobal(key: string, value: string): void {
    this.setSetting(this.resolveSettingKey("global", key), value);
  }

  /** Get a global setting. */
  getGlobal(key: string): string | undefined {
    return this.getSetting(this.resolveSettingKey("global", key));
  }

  /** Set a per-account override. */
  setAccount(accountId: string, key: string, value: string): void {
    this.setSetting(this.resolveSettingKey(`account.${accountId}`, key), value);
  }

  /** Get a per-account override (without global fallback). */
  getAccount(accountId: string, key: string): string | undefined {
    return this.getSetting(this.resolveSettingKey(`account.${accountId}`, key));
  }

  /** Remove a per-account override (falls back to global). */
  resetAccount(accountId: string, key: string): void {
    this.deleteSetting(this.resolveSettingKey(`account.${accountId}`, key));
  }

  // ── Observer settings ────────────────────────────────────────────

  private resolveSettings(accountId?: string): ObserverSettings {
    const rawMode = this.getScoped(accountId, "mode");
    const mode: ObserverMode =
      rawMode && (OBSERVER_MODES as readonly string[]).includes(rawMode)
        ? (rawMode as ObserverMode)
        : DEFAULT_OBSERVER_MODE;

    let blocklist: string[] = [];
    try {
      const raw = this.getScoped(accountId, "filters.blocklist");
      if (raw) blocklist = JSON.parse(raw) as string[];
    } catch { /* invalid JSON, use default */ }

    let allowlist: string[] = ["*"];
    try {
      const raw = this.getScoped(accountId, "filters.allowlist");
      if (raw) allowlist = JSON.parse(raw) as string[];
    } catch { /* invalid JSON, use default */ }

    const rawRetention = this.getScoped(accountId, "retentionDays");
    const retentionDays = rawRetention ? Number(rawRetention) : 90;

    return {
      mode,
      filters: { blocklist, allowlist },
      retentionDays: Number.isFinite(retentionDays) ? retentionDays : 90,
    };
  }

  /** Get observer settings for an account (with global fallback). */
  getAccountSettings(accountId: string): ObserverSettings {
    return this.resolveSettings(accountId);
  }

  /** Get global observer settings (no account context). */
  getObserverSettings(): ObserverSettings {
    return this.resolveSettings();
  }

  hasSettings(): boolean {
    const rows = this.query("SELECT COUNT(*) AS count FROM settings");
    return (rows[0]?.count as number) > 0;
  }

  /** Seed global defaults. Only writes if no settings exist yet. */
  seedSettings(settings: ObserverSettings): void {
    if (this.hasSettings()) return;
    this.setGlobal("mode", settings.mode);
    this.setGlobal("filters.blocklist", JSON.stringify(settings.filters.blocklist));
    this.setGlobal("filters.allowlist", JSON.stringify(settings.filters.allowlist));
    this.setGlobal("retentionDays", String(settings.retentionDays));
  }

  // ── Contacts ──────────────────────────────────────────────────────

  upsertContact(contact: {
    jid: string;
    accountId: string;
    phone?: string;
    pushName?: string;
    businessName?: string;
    isGroup?: boolean;
    groupSubject?: string;
    groupDescription?: string;
  }): void {
    this.run(
      `INSERT INTO contacts (jid, account_id, phone, push_name, business_name, is_group, group_subject, group_description, updated_at)
       VALUES (:jid, :accountId, :phone, :pushName, :businessName, :isGroup, :groupSubject, :groupDescription, :updatedAt)
       ON CONFLICT(jid, account_id) DO UPDATE SET
         phone = COALESCE(excluded.phone, contacts.phone),
         push_name = COALESCE(excluded.push_name, contacts.push_name),
         business_name = COALESCE(excluded.business_name, contacts.business_name),
         is_group = MAX(excluded.is_group, contacts.is_group),
         group_subject = COALESCE(excluded.group_subject, contacts.group_subject),
         group_description = COALESCE(excluded.group_description, contacts.group_description),
         updated_at = excluded.updated_at`,
      {
        ":jid": contact.jid,
        ":accountId": contact.accountId,
        ":phone": contact.phone ?? null,
        ":pushName": contact.pushName ?? null,
        ":businessName": contact.businessName ?? null,
        ":isGroup": contact.isGroup ? 1 : 0,
        ":groupSubject": contact.groupSubject ?? null,
        ":groupDescription": contact.groupDescription ?? null,
        ":updatedAt": Date.now(),
      },
    );
  }

  getContact(jid: string, accountId?: string): Record<string, unknown> | undefined {
    const rows = this.query(`SELECT * FROM contacts WHERE jid = :jid${accountId ? " AND account_id = :accountId" : ""}`, { ":jid": jid, ...(accountId ? { ":accountId": accountId } : {}) });
    return rows[0];
  }

  listContacts(params: {
    accountId?: string;
    isGroup?: boolean;
    limit?: number;
  }): Array<Record<string, unknown>> {
    const conditions: string[] = [];
    const binds: Record<string, unknown> = {};
    if (params.accountId) {
      conditions.push("account_id = :accountId");
      binds[":accountId"] = params.accountId;
    }
    if (params.isGroup !== undefined) {
      conditions.push("is_group = :isGroup");
      binds[":isGroup"] = params.isGroup ? 1 : 0;
    }
    const limit = Math.min(params.limit ?? 200, 500);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.query(
      `SELECT * FROM contacts ${where} ORDER BY updated_at DESC LIMIT :limit`,
      { ...binds, ":limit": limit },
    );
  }

  /** Resolve a JID to a display name using the contacts table. */
  resolveContactName(jid: string, accountId?: string): string | undefined {
    const contact = this.getContact(jid, accountId);
    if (!contact) return undefined;
    return (contact.push_name as string)
      ?? (contact.business_name as string)
      ?? (contact.group_subject as string)
      ?? (contact.phone as string)
      ?? undefined;
  }

  // ── FTS Search ───────────────────────────────────────────────────

  /** Full-text search using FTS5 when available, LIKE fallback otherwise. */
  searchFts(params: {
    query: string;
    sender?: string;
    group?: string;
    afterDate?: number;
    beforeDate?: number;
    accountId?: string;
    limit?: number;
  }): Array<Record<string, unknown>> {
    if (this.ftsEnabled && params.query.trim()) {
      return this.searchWithFts5(params);
    }
    return this.search(params);
  }

  private searchWithFts5(params: {
    query: string;
    sender?: string;
    group?: string;
    afterDate?: number;
    beforeDate?: number;
    accountId?: string;
    limit?: number;
  }): Array<Record<string, unknown>> {
    const conditions: string[] = ["messages_fts MATCH :ftsQuery"];
    const binds: Record<string, unknown> = {
      ":ftsQuery": params.query.split(/\s+/).filter(Boolean).map(t => `"${t.replaceAll('"', '""')}"`).join(" OR "),
    };

    if (params.sender) {
      conditions.push("(m.sender = :sender OR m.sender_e164 = :sender OR m.sender_name LIKE :senderLike)");
      binds[":sender"] = params.sender;
      binds[":senderLike"] = `%${params.sender}%`;
    }
    if (params.group) {
      conditions.push("(m.conversation_id = :group OR m.group_name LIKE :groupLike)");
      binds[":group"] = params.group;
      binds[":groupLike"] = `%${params.group}%`;
    }
    if (params.afterDate) {
      conditions.push("m.timestamp >= :afterDate");
      binds[":afterDate"] = params.afterDate;
    }
    if (params.beforeDate) {
      conditions.push("m.timestamp <= :beforeDate");
      binds[":beforeDate"] = params.beforeDate;
    }
    if (params.accountId) {
      conditions.push("m.account_id = :accountId");
      binds[":accountId"] = params.accountId;
    }

    const limit = Math.min(params.limit ?? 50, 200);
    const where = conditions.join(" AND ");

    return this.query(
      `SELECT m.* FROM visible_messages m
       JOIN messages_fts ON messages_fts.rowid = m.id
       WHERE ${where}
       ORDER BY m.timestamp DESC
       LIMIT :limit`,
      { ...binds, ":limit": limit },
    );
  }

  /** Get pending backfill requests for an account. */
  getPendingBackfills(accountId: string): Array<{ key: string; value: Record<string, unknown> }> {
    const rows = this.query(
      "SELECT key, value FROM settings WHERE key LIKE :prefix",
      { ":prefix": `backfill.pending.${accountId}.%` },
    );
    return rows.map((row) => ({
      key: row.key as string,
      value: JSON.parse(row.value as string) as Record<string, unknown>,
    }));
  }

  /** Get the oldest message for a conversation (used as anchor for backfill). */
  getOldestMessage(conversationId: string, accountId?: string): Record<string, unknown> | undefined {
    const conditions = ["conversation_id = :conversationId", "message_type IN ('message', 'poll')", "message_id IS NOT NULL"];
    const binds: Record<string, unknown> = { ":conversationId": conversationId };
    if (accountId) {
      conditions.push("account_id = :accountId");
      binds[":accountId"] = accountId;
    }
    const rows = this.query(
      `SELECT * FROM visible_messages WHERE ${conditions.join(" AND ")} ORDER BY timestamp ASC LIMIT 1`,
      binds,
    );
    return rows[0];
  }

  // ── Key migration ────────────────────────────────────────────────

  /** Migrate unscoped keys (from before per-account support) to global.* prefix. */
  migrateToScopedKeys(): void {
    const legacyKeys = ["mode", "filters.blocklist", "filters.allowlist", "retentionDays"];
    for (const key of legacyKeys) {
      const legacy = this.getSetting(key);
      if (legacy !== undefined && this.getGlobal(key) === undefined) {
        this.setGlobal(key, legacy);
        this.deleteSetting(key);
      }
    }
  }

  // ── Persistence ──────────────────────────────────────────────────

  // SQLite commits each write directly; retained for CLI callers.
  flush(): void {}

  insertMessage(msg: ObserverMessage): void {
    this.run(INSERT_SQL, {
      ":messageId": msg.messageId ?? null,
      ":fromMe": msg.fromMe ? 1 : 0,
      ":accountId": msg.accountId,
      ":sender": msg.sender,
      ":senderName": msg.senderName ?? null,
      ":senderE164": msg.senderE164 ?? null,
      ":conversationId": msg.conversationId,
      ":isGroup": msg.isGroup ? 1 : 0,
      ":groupId": msg.isGroup ? msg.conversationId : null,
      ":groupName": msg.groupName ?? null,
      ":content": msg.content ?? null,
      ":mediaType": msg.mediaType ?? null,
      ":mediaPath": msg.mediaPath ?? null,
      ":mediaMime": msg.mediaMime ?? null,
      ":timestamp": msg.timestamp,
      ":messageType": msg.messageType ?? "message",
      ":refMessageId": msg.refMessageId ?? null,
      ":source": msg.source ?? "observer",
      ":loggedAt": Date.now(),
    });
  }

  private query(sql: string, binds: Record<string, unknown> = {}): Array<Record<string, unknown>> {
    if (this.queryDepth === 0) this.visibilitySettings.clear();
    this.queryDepth++;
    try {
      return this.db.prepare(sql).all(binds as Record<string, SQLInputValue>);
    } finally {
      this.queryDepth--;
    }
  }

  search(params: {
    query: string;
    sender?: string;
    group?: string;
    afterDate?: number;
    beforeDate?: number;
    accountId?: string;
    limit?: number;
  }): Array<Record<string, unknown>> {
    const conditions: string[] = [];
    const binds: Record<string, unknown> = {};

    const terms = params.query.split(/\s+/).filter(Boolean);
    for (let i = 0; i < terms.length; i++) {
      conditions.push(`(m.content LIKE :term${i} OR m.sender_name LIKE :term${i} OR m.group_name LIKE :term${i})`);
      binds[`:term${i}`] = `%${terms[i]}%`;
    }

    if (params.sender) {
      conditions.push("(m.sender = :sender OR m.sender_e164 = :sender OR m.sender_name LIKE :senderLike)");
      binds[":sender"] = params.sender;
      binds[":senderLike"] = `%${params.sender}%`;
    }
    if (params.group) {
      conditions.push("(m.group_id = :group OR m.group_name LIKE :groupLike)");
      binds[":group"] = params.group;
      binds[":groupLike"] = `%${params.group}%`;
    }
    if (params.afterDate) {
      conditions.push("m.timestamp >= :afterDate");
      binds[":afterDate"] = params.afterDate;
    }
    if (params.beforeDate) {
      conditions.push("m.timestamp <= :beforeDate");
      binds[":beforeDate"] = params.beforeDate;
    }
    if (params.accountId) {
      conditions.push("m.account_id = :accountId");
      binds[":accountId"] = params.accountId;
    }

    if (conditions.length === 0) {
      conditions.push("1=1");
    }

    const limit = Math.min(params.limit ?? 50, 200);
    const sql = `
      SELECT m.id, m.message_id, m.account_id, m.sender, m.sender_name,
             m.sender_e164, m.conversation_id, m.is_group, m.group_id,
             m.group_name, m.content, m.media_type, m.media_path,
             m.timestamp, m.logged_at, m.message_type, m.ref_message_id, m.source
      FROM visible_messages m
      WHERE ${(conditions.length ? conditions.join(" AND ") : "1 = 1")}
      ORDER BY m.timestamp DESC
      LIMIT :limit
    `;
    binds[":limit"] = limit;

    return this.query(sql, binds);
  }

  getRecent(params: {
    conversationId?: string;
    sender?: string;
    accountId?: string;
    limit?: number;
  }): Array<Record<string, unknown>> {
    const conditions: string[] = [];
    const binds: Record<string, unknown> = {};

    if (params.conversationId) {
      conditions.push("conversation_id = :conversationId");
      binds[":conversationId"] = params.conversationId;
    }
    if (params.sender) {
      conditions.push("(sender = :sender OR sender_e164 = :sender OR sender_name LIKE :senderLike)");
      binds[":sender"] = params.sender;
      binds[":senderLike"] = `%${params.sender}%`;
    }
    if (params.accountId) {
      conditions.push("account_id = :accountId");
      binds[":accountId"] = params.accountId;
    }

    const limit = Math.min(params.limit ?? 50, 200);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT id, message_id, account_id, sender, sender_name,
             sender_e164, conversation_id, is_group, group_id,
             group_name, content, media_type, media_path,
             timestamp, logged_at, message_type, ref_message_id, source
      FROM visible_messages
      ${where}
      ORDER BY timestamp DESC
      LIMIT :limit
    `;
    binds[":limit"] = limit;

    return this.query(sql, binds);
  }

  getHistory(params: {
    conversationId: string;
    accountId?: string;
    afterDate?: number;
    beforeDate?: number;
    limit?: number;
  }): Array<Record<string, unknown>> {
    const conditions: string[] = ["conversation_id = :conversationId"];
    const binds: Record<string, unknown> = { ":conversationId": params.conversationId };

    if (params.accountId) {
      conditions.push("account_id = :accountId");
      binds[":accountId"] = params.accountId;
    }
    if (params.afterDate) {
      conditions.push("timestamp >= :afterDate");
      binds[":afterDate"] = params.afterDate;
    }
    if (params.beforeDate) {
      conditions.push("timestamp <= :beforeDate");
      binds[":beforeDate"] = params.beforeDate;
    }

    const limit = Math.min(params.limit ?? 100, 500);
    const where = `WHERE ${conditions.join(" AND ")}`;
    const sql = `
      SELECT id, message_id, account_id, sender, sender_name,
             sender_e164, conversation_id, is_group, group_id,
             group_name, content, media_type, media_path,
             timestamp, logged_at, message_type, ref_message_id, source
      FROM visible_messages
      ${where}
      ORDER BY timestamp ASC
      LIMIT :limit
    `;
    binds[":limit"] = limit;

    return this.query(sql, binds);
  }

  listConversations(params: {
    accountId?: string;
    limit?: number;
  }): ConversationSummary[] {
    const conditions: string[] = [];
    const binds: Record<string, unknown> = {};

    if (params.accountId) {
      conditions.push("account_id = :accountId");
      binds[":accountId"] = params.accountId;
    }

    const limit = Math.min(params.limit ?? 50, 200);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT
        conversation_id AS conversationId,
        (SELECT m4.account_id FROM visible_messages m4
         WHERE m4.conversation_id = visible_messages.conversation_id AND m4.account_id = visible_messages.account_id
         ORDER BY m4.timestamp DESC LIMIT 1) AS accountId,
        MAX(group_name) AS groupName,
        (SELECT m3.sender_name FROM visible_messages m3
         WHERE m3.conversation_id = visible_messages.conversation_id AND m3.account_id = visible_messages.account_id
           AND m3.sender_name IS NOT NULL AND m3.sender_name != ''
         ORDER BY m3.timestamp DESC LIMIT 1) AS contactName,
        COUNT(*) AS messageCount,
        MAX(timestamp) AS lastMessageAt,
        (SELECT sender FROM visible_messages m2
         WHERE m2.conversation_id = visible_messages.conversation_id AND m2.account_id = visible_messages.account_id
         ORDER BY m2.timestamp DESC LIMIT 1) AS lastSender
      FROM visible_messages
      ${where}
      GROUP BY conversation_id, account_id
      ORDER BY MAX(timestamp) DESC
      LIMIT :limit
    `;
    binds[":limit"] = limit;

    return this.query(sql, binds) as unknown as ConversationSummary[];
  }

  getStats(params: {
    accountId?: string;
    afterDate?: number;
    groupBy?: "sender" | "group" | "day" | "hour";
  }): ObserverStats & { grouped?: StatsGroupByResult[] } {
    const conditions: string[] = [];
    const binds: Record<string, unknown> = {};

    if (params.accountId) {
      conditions.push("account_id = :accountId");
      binds[":accountId"] = params.accountId;
    }
    if (params.afterDate) {
      conditions.push("timestamp >= :afterDate");
      binds[":afterDate"] = params.afterDate;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const statsSql = `
      SELECT
        COUNT(*) AS totalMessages,
        COUNT(DISTINCT sender) AS uniqueSenders,
        COUNT(DISTINCT conversation_id) AS uniqueConversations,
        MIN(timestamp) AS firstMessageAt,
        MAX(timestamp) AS lastMessageAt
      FROM visible_messages
      ${where}
    `;

    const statsRows = this.query(statsSql, binds);
    const stats = (statsRows[0] ?? {
      totalMessages: 0,
      uniqueSenders: 0,
      uniqueConversations: 0,
      firstMessageAt: null,
      lastMessageAt: null,
    }) as ObserverStats;

    let grouped: StatsGroupByResult[] | undefined;
    if (params.groupBy) {
      let groupExpr: string;
      switch (params.groupBy) {
        case "sender":
          groupExpr = "COALESCE(sender_name, sender)";
          break;
        case "group":
          groupExpr = "COALESCE(group_name, conversation_id)";
          break;
        case "day":
          groupExpr = "date(timestamp / 1000, 'unixepoch')";
          break;
        case "hour":
          groupExpr = "strftime('%H', timestamp / 1000, 'unixepoch')";
          break;
      }

      const groupSql = `
        SELECT ${groupExpr} AS key, COUNT(*) AS count
        FROM visible_messages
        ${where}
        GROUP BY ${groupExpr}
        ORDER BY count DESC
        LIMIT 50
      `;
      grouped = this.query(groupSql, binds) as unknown as StatsGroupByResult[];
    }

    return { ...stats, grouped };
  }

  prune(retentionDays: number, accountId?: string): number {
    if (retentionDays <= 0) return 0;
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    this.run(`DELETE FROM messages WHERE timestamp < :cutoff${accountId ? " AND account_id = :accountId" : ""}`, { ":cutoff": cutoffMs, ...(accountId ? { ":accountId": accountId } : {}) });
    const result = this.query("SELECT changes() AS count");
    return (result[0]?.count as number) ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
