import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { ObserverDB } from "../src/observer/db.js";
import { attachObserverListeners, processObserverMessage, requestBackfill } from "../src/observer/monitor.js";
import { parseObserverConfig } from "../src/observer-config.js";
import type { WASocket, WAMessage } from "baileys";

const config = parseObserverConfig(undefined);
const message = (id: string, accountId = "a", sender = "+111", timestamp = Date.now()) => ({
  messageId: id, accountId, sender, conversationId: "111@s.whatsapp.net", isGroup: false,
  content: `hello ${id}`, timestamp,
});

describe("shared SQLite storage", () => {
  let dir: string;
  let db: ObserverDB;
  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "wa-db-")); db = await ObserverDB.create(join(dir, "messages.db")); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("shares committed messages, settings and backfill requests across processes without lost writes", () => {
    db.insertMessage(message("first"));
    const path = join(dir, "messages.db");
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { ObserverDB } from './src/observer/db.ts';
      const db = await ObserverDB.create(process.argv[1]);
      db.setAccount('a', 'retentionDays', '7');
      db.setSetting('backfill.pending.a.test', JSON.stringify({conversationId:'111@s.whatsapp.net'}));
      db.insertMessage({messageId:'child', accountId:'a', sender:'+111',conversationId:'111@s.whatsapp.net',isGroup:false,timestamp:1});
      db.close();
    `, path]);
    expect(db.getAccountSettings("a").retentionDays).toBe(7);
    expect(db.getPendingBackfills("a")).toHaveLength(1);
    db.insertMessage(message("third"));
    expect(db.getStats({}).totalMessages).toBe(3);
  });

  it("enforces each account's live filters before limits, search, summaries and statistics", () => {
    for (let i = 0; i < 10; i++) db.insertMessage(message(`blocked${i}`, "a", "+blocked", 100 + i));
    db.insertMessage(message("allowed", "a", "+111", 1));
    db.insertMessage(message("other-account", "b", "+blocked", 200));
    db.setAccount("a", "mode", "record-all-retrieve-filtered");
    db.setAccount("a", "filters.blocklist", JSON.stringify(["+blocked"]));
    expect(db.getRecent({ accountId: "a", limit: 1 })[0].message_id).toBe("allowed");
    expect(db.searchFts({ query: "hello" })).toHaveLength(2);
    expect(db.getHistory({ conversationId: "111@s.whatsapp.net" })).toHaveLength(2);
    expect(db.getStats({}).totalMessages).toBe(2);
    expect(db.listConversations({}).map((row) => row.messageCount)).toEqual([1, 1]);
    db.setAccount("a", "mode", "record-filtered-retrieve-filtered");
    expect(db.getStats({ accountId: "a" }).totalMessages).toBe(1);
  });

  it("keeps account-specific retention and contact names separate", () => {
    db.insertMessage(message("old-a", "a", "+111", 1));
    db.insertMessage(message("old-b", "b", "+111", 1));
    expect(db.prune(1, "a")).toBe(1);
    expect(db.getStats({ accountId: "b" }).totalMessages).toBe(1);
    db.upsertContact({ jid: "111@s.whatsapp.net", accountId: "a", pushName: "Alice" });
    db.upsertContact({ jid: "111@s.whatsapp.net", accountId: "b", pushName: "Bob" });
    db.upsertContact({ jid: "111@s.whatsapp.net", accountId: "a", phone: "+111" });
    expect(db.getContact("111@s.whatsapp.net", "a")?.push_name).toBe("Alice");
    expect(db.getContact("111@s.whatsapp.net", "b")?.push_name).toBe("Bob");
  });

  it("migrates legacy contacts and indexes existing messages with FTS5", async () => {
    const legacyPath = join(dir, "legacy.db");
    const native = new DatabaseSync(legacyPath);
    native.exec(`CREATE TABLE contacts (jid TEXT PRIMARY KEY, account_id TEXT NOT NULL, phone TEXT, push_name TEXT, business_name TEXT,
      is_group INTEGER NOT NULL DEFAULT 0, group_subject TEXT, group_description TEXT, updated_at INTEGER NOT NULL DEFAULT 0);
      INSERT INTO contacts(jid, account_id, push_name) VALUES ('111@s.whatsapp.net', 'a', 'Legacy');`);
    native.close();
    const legacy = await ObserverDB.create(legacyPath);
    legacy.upsertContact({ jid: "111@s.whatsapp.net", accountId: "b", pushName: "Other" });
    expect(legacy.listContacts({})).toHaveLength(2);
    legacy.insertMessage(message("fts"));
    expect(legacy.searchFts({ query: 'hello "fts"' })).toHaveLength(1);
    legacy.close();
  });

  it("does not replace a corrupt database", async () => {
    const path = join(dir, "corrupt.db");
    writeFileSync(path, "not a database");
    await expect(ObserverDB.create(path)).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("not a database");
  });
});

function socket() {
  const listeners = new Map<string, Set<(data: any) => void>>();
  const sock = {
    user: { id: "999:3@s.whatsapp.net" },
    signalRepository: {},
    ev: {
      on(name: string, fn: (data: any) => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
      off(name: string, fn: (data: any) => void) { listeners.get(name)?.delete(fn); },
    },
    sendMessage: vi.fn(async () => ({ key: { id: "sent", remoteJid: "111@s.whatsapp.net", fromMe: true }, message: { conversation: "sent hello" } })),
    fetchMessageHistory: vi.fn(async () => "requested"),
    groupMetadata: vi.fn(async () => ({ subject: "Team" })),
  };
  return { sock: sock as unknown as WASocket, emit: (name: string, data: unknown) => listeners.get(name)?.forEach(fn => fn(data)) };
}

describe("wire capture", () => {
  let db: ObserverDB;
  beforeEach(async () => { db = await ObserverDB.create(":memory:"); });
  afterEach(() => db.close());

  it("rejects direct socket sends for observer accounts, including normalized IDs", async () => {
    const { sock } = socket();
    const send = sock.sendMessage;
    const dispose = attachObserverListeners(sock, { db, config: { ...config, observerAccounts: ["Passive"] }, accountId: "passive" });
    await expect(sock.sendMessage("111@s.whatsapp.net", { text: "blocked" })).rejects.toThrow("cannot send");
    expect(send).not.toHaveBeenCalled();
    await dispose();
    await expect(sock.sendMessage("111@s.whatsapp.net", { text: "still blocked" })).rejects.toThrow("cannot send");
  });

  it("captures history, live messages, outbound, reactions, edits and deletes through the same listeners", async () => {
    const { sock, emit } = socket();
    const dispose = attachObserverListeners(sock, { db, config, accountId: "a" });
    emit("connection.update", { connection: "open" });
    emit("messaging-history.set", { messages: [{ key: { id: "history", remoteJid: "111@s.whatsapp.net" }, message: { conversation: "past" } }], contacts: [], chats: [] });
    const key = { id: "live", remoteJid: "111@s.whatsapp.net" };
    emit("messages.upsert", { messages: [{ key, message: { conversation: "now" } }] });
    await sock.sendMessage("111@s.whatsapp.net", { text: "sent hello" });
    emit("messages.reaction", [{ key, reaction: { key: { id: "react", remoteJid: key.remoteJid }, text: "👍" } }]);
    emit("messages.update", [{ key, update: { message: { editedMessage: { message: { conversation: "edited" } } } } }]);
    emit("messages.update", [{ key, update: { messageStubType: 1 } }]);
    await dispose();
    const rows = db.getRecent({});
    expect(rows).toHaveLength(6);
    expect(rows.map(r => r.message_type).sort()).toEqual(["delete", "edit", "message", "message", "message", "reaction"]);
    expect(rows.find(r => r.message_id === "sent")?.sender).toBe("+999");
    expect(rows.find(r => r.message_type === "edit")?.ref_message_id).toBe("live");
  });

  it("deduplicates real Baileys edit and revoke events against their wire upserts", async () => {
    const { sock, emit } = socket();
    const dispose = attachObserverListeners(sock, { db, config, accountId: "a" });
    const key = { id: "original", remoteJid: "111@s.whatsapp.net" };
    emit("messages.upsert", { messages: [{ key, message: { conversation: "before" }, messageTimestamp: 1 }] });
    emit("messages.upsert", { messages: [{
      key: { ...key, id: "edit-wire" },
      message: { protocolMessage: { key, editedMessage: { conversation: "after" }, timestampMs: 5432 } }, messageTimestamp: 4,
    }] });
    emit("messages.update", [{ key, update: { message: { editedMessage: { message: { conversation: "after" } } }, messageTimestamp: 5 } }]);
    emit("messages.upsert", { messages: [{ key: { ...key, id: "revoke-wire" }, message: { protocolMessage: { type: 0, key } }, messageTimestamp: 6 }] });
    emit("messages.update", [{ key, update: { messageStubType: 1 } }]);
    await dispose();
    const rows = db.getRecent({});
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.message_type === "edit")?.content).toBe("after");
    expect(rows.find(row => row.message_type === "delete")?.ref_message_id).toBe("original");
  });

  it("captures current poll variants and newsletter messages", async () => {
    for (const field of ["pollCreationMessage", "pollCreationMessageV2", "pollCreationMessageV3", "pollCreationMessageV5"]) {
      await processObserverMessage({
        key: { id: field, remoteJid: "111@s.whatsapp.net" },
        message: { [field]: { name: "Lunch?", options: [{ optionName: "Yes" }] } },
      } as WAMessage, null, { db, config, accountId: "a" });
    }
    await processObserverMessage({
      key: { id: "newsletter", remoteJid: "123@newsletter" }, message: { conversation: "News" },
    }, null, { db, config, accountId: "a" });
    expect(db.getRecent({}).filter(row => row.message_type === "poll")).toHaveLength(4);
    expect(db.getHistory({ conversationId: "123@newsletter" })[0].content).toBe("News");
  });

  it("filters reaction and delete updates at ingestion and preserves unknown LIDs", async () => {
    const { sock, emit } = socket();
    db.setAccount("a", "mode", "record-filtered-retrieve-filtered");
    db.setAccount("a", "filters.blocklist", JSON.stringify(["+111"]));
    const dispose = attachObserverListeners(sock, { db, config, accountId: "a" });
    const key = { id: "hidden", remoteJid: "111@s.whatsapp.net" };
    emit("messages.update", [{ key, update: { messageStubType: 1 } }]);
    emit("messages.reaction", [{ key, reaction: { key, text: "👍" } }]);
    emit("messages.upsert", { messages: [{ key: { id: "lid", remoteJid: "123@lid" }, message: { conversation: "hello" } }] });
    await dispose();
    const rows = db.getRecent({});
    expect(rows).toHaveLength(1);
    expect(rows[0].sender).toBe("123@lid");
    expect(rows[0].sender_e164).toBeNull();
  });

  it("uses the original outbound key for backfill on normal accounts", async () => {
    const { sock, emit } = socket();
    const dispose = attachObserverListeners(sock, { db, config, accountId: "a" });
    emit("connection.update", { connection: "open" });
    db.insertMessage({ ...message("outbound"), fromMe: true });
    expect(await requestBackfill({ db, accountId: "a", conversationId: "111@s.whatsapp.net", count: 20 })).toBe(20);
    expect(sock.fetchMessageHistory).toHaveBeenCalledWith(20, { id: "outbound", remoteJid: "111@s.whatsapp.net", fromMe: true }, expect.any(Number));
    await dispose();
  });
});
