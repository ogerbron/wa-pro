import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObserverDB } from "../src/observer/db.js";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const cli = (path: string, ...args: string[]) => execFileSync(process.execPath, ["cli/bin/run.mjs", ...args, "--db", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("CLI against the live database", () => {
  it("queries, filters, queues backfills, and changes settings visible to an already-open gateway", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-cli-")); dirs.push(dir);
    const path = join(dir, "messages.db");
    const db = await ObserverDB.create(path);
    try {
      for (const accountId of ["a", "b"]) db.insertMessage({ messageId: "hello", accountId, sender: "+111", conversationId: "111@s.whatsapp.net", isGroup: false, content: "hello world", timestamp: Date.now() });
      expect(JSON.parse(cli(path, "search", "hello", "--account", "b"))).toHaveLength(1);
      cli(path, "config", "mode", "record-all-retrieve-filtered", "--account", "a");
      cli(path, "config", "blocklist", "add", "+111", "--account", "a");
      expect(db.getAccountSettings("a").mode).toBe("record-all-retrieve-filtered");
      expect(JSON.parse(cli(path, "recent"))).toHaveLength(1);
      expect(JSON.parse(cli(path, "stats")).totalMessages).toBe(1);
      expect(JSON.parse(cli(path, "conversations"))).toHaveLength(1);
      expect(JSON.parse(cli(path, "history", "111@s.whatsapp.net", "--account", "a"))).toEqual([]);
      cli(path, "backfill", "111@s.whatsapp.net", "--account", "b", "--wait", "0");
      expect(db.getPendingBackfills("b")).toHaveLength(1);
      expect(db.getStats({ accountId: "b" }).totalMessages).toBe(1);
    } finally { db.close(); }
  }, 30_000);
});
