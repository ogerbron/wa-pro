import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ObserverDB } from "../src/observer/db.js";
import { startTranscriptionWorker } from "../src/observer/transcription.js";

describe("queued observer transcription", () => {
  let dir: string;
  let db: ObserverDB;
  let stop: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    vi.useFakeTimers();
    stop = undefined;
    dir = mkdtempSync(join(tmpdir(), "wa-transcription-"));
    db = await ObserverDB.create(join(dir, "messages.db"));
    writeFileSync(join(dir, "voice.ogg"), "audio fixture");
  });
  afterEach(async () => {
    await stop?.();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });
  function audio(messageId = "voice", accountId = "a") {
    db.insertMessage({ messageId, accountId, sender: "+111", conversationId: "111@s.whatsapp.net",
      isGroup: false, content: "[audio]", mediaType: "audio", mediaMime: "audio/ogg; codecs=opus",
      mediaPath: join(dir, "voice.ogg"), timestamp: 1234 });
    return Number(db.getRecent({ accountId }).find(row => row.message_id === messageId)!.id);
  }
  async function drain() {
    await vi.advanceTimersByTimeAsync(1000);
    // Fake timers do not wait for real filesystem I/O in the worker.
    await vi.waitFor(() => expect(db.query(
      "SELECT COUNT(*) AS count FROM messages WHERE transcription_status IN ('pending', 'processing')",
    )[0].count).toBe(0));
  }

  it("does nothing on capture; a queued job enriches the original row and becomes searchable", async () => {
    const id = audio();
    const original = db.getRecent({})[0];
    const transcribe = vi.fn(async () => ({ text: "Meet me tomorrow at noon" }));
    stop = startTranscriptionWorker({ db, transcribe });
    await drain();
    expect(transcribe).not.toHaveBeenCalled();
    expect(db.queueTranscription(id).transcription_status).toBe("pending");
    await drain();
    expect(transcribe).toHaveBeenCalledExactlyOnceWith(join(dir, "voice.ogg"), "audio/ogg; codecs=opus");
    const row = db.getRecent({})[0];
    expect(row).toMatchObject({ ...original, transcript: "Meet me tomorrow at noon",
      transcription_status: "completed", transcription_error: null, transcribed_at: expect.any(Number) });
    expect(db.searchFts({ query: "tomorrow" })[0].id).toBe(id);
    expect(db.search({ query: "tomorrow" })[0].id).toBe(id);
    expect(db.getHistory({ conversationId: "111@s.whatsapp.net" })[0].transcript).toBe(row.transcript);
    expect(db.getStats({}).totalMessages).toBe(1);
    db.queueTranscription(id);
    await drain();
    expect(transcribe).toHaveBeenCalledTimes(1);
    db.prune(1);
    expect(db.searchFts({ query: "tomorrow" })).toEqual([]);
  });

  it("records failure without looping and allows an explicit retry", async () => {
    const id = audio();
    db.queueTranscription(id);
    const transcribe = vi.fn().mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ text: "Recovered transcript" });
    stop = startTranscriptionWorker({ db, transcribe });
    await drain();
    expect(db.getRecent({})[0]).toMatchObject({ transcription_status: "failed",
      transcription_error: "provider unavailable", transcript: null, content: "[audio]" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(transcribe).toHaveBeenCalledTimes(1);
    db.queueTranscription(id);
    await drain();
    expect(db.getRecent({})[0]).toMatchObject({ transcription_status: "completed",
      transcript: "Recovered transcript", transcription_error: null });
  });

  it("treats an empty OpenClaw result as a failure and continues to the next job", async () => {
    const first = audio("one");
    const second = audio("two");
    db.queueTranscription(first);
    db.queueTranscription(second);
    const transcribe = vi.fn().mockResolvedValueOnce({ text: undefined })
      .mockResolvedValueOnce({ text: "Second note" });
    stop = startTranscriptionWorker({ db, transcribe });
    await drain();
    expect(db.query("SELECT transcription_status FROM messages ORDER BY id").map(row => row.transcription_status))
      .toEqual(["failed", "completed"]);
  });

  it("fails a missing file before calling the engine", async () => {
    const id = audio();
    rmSync(join(dir, "voice.ogg"));
    db.queueTranscription(id);
    const transcribe = vi.fn();
    stop = startTranscriptionWorker({ db, transcribe });
    await drain();
    expect(transcribe).not.toHaveBeenCalled();
    expect(db.getRecent({})[0].transcription_status).toBe("failed");
  });

  it("queues only visible audio with a file and keeps account rows separate", () => {
    const first = audio("same", "a");
    const second = audio("same", "b");
    db.setAccount("a", "mode", "record-all-retrieve-filtered");
    db.setAccount("a", "filters.blocklist", JSON.stringify(["+111"]));
    expect(() => db.queueTranscription(first)).toThrow(/not found|visible/i);
    db.queueTranscription(second);
    db.queueTranscription(second);
    expect(db.claimNextTranscription()?.id).toBe(second);
    expect(db.claimNextTranscription()).toBeUndefined();
    db.insertMessage({ messageId: "text", accountId: "b", sender: "+111", conversationId: "c",
      isGroup: false, content: "hello", timestamp: 10 });
    const text = db.getRecent({ accountId: "b" }).find(row => row.message_id === "text")!;
    expect(() => db.queueTranscription(Number(text.id))).toThrow(/audio/i);
    db.query("UPDATE messages SET media_path = NULL WHERE id = :id", { ":id": second });
    expect(() => db.queueTranscription(second)).toThrow(/file/i);
  });

  it("claims atomically across connections and recovers interrupted work after restart", async () => {
    const id = audio();
    db.queueTranscription(id);
    const other = await ObserverDB.create(join(dir, "messages.db"));
    try {
      expect(other.claimNextTranscription()?.id).toBe(id);
      expect(db.claimNextTranscription()).toBeUndefined();
      const transcribe = vi.fn(async () => ({ text: "After restart" }));
      stop = startTranscriptionWorker({ db, transcribe });
      await drain();
      expect(other.getRecent({})[0].transcript).toBe("After restart");
    } finally { other.close(); }
  });

  it("waits for an active transcription on shutdown without overlapping jobs", async () => {
    const first = audio("one");
    const second = audio("two");
    db.queueTranscription(first);
    db.queueTranscription(second);
    let finish!: (value: { text: string }) => void;
    const transcribe = vi.fn(() => new Promise<{ text: string }>(resolve => { finish = resolve; }));
    stop = startTranscriptionWorker({ db, transcribe });
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5000);
    expect(transcribe).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish({ text: "Finished" });
    await stopping;
    expect(db.query("SELECT transcription_status FROM messages ORDER BY id").map(row => row.transcription_status))
      .toEqual(["completed", "pending"]);
  });

  it("migrates an existing message and FTS index in place and survives reopening", async () => {
    const id = audio();
    db.close();
    const path = join(dir, "messages.db");
    const native = new DatabaseSync(path);
    native.exec(`DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_update; DROP TRIGGER messages_fts_delete;
      DROP TABLE messages_fts;
      DROP INDEX idx_messages_transcription_pending;
      ALTER TABLE messages DROP COLUMN transcript;
      ALTER TABLE messages DROP COLUMN transcription_status;
      ALTER TABLE messages DROP COLUMN transcription_error;
      ALTER TABLE messages DROP COLUMN transcribed_at;
      CREATE VIRTUAL TABLE messages_fts USING fts5(content, sender_name, group_name, content='messages', content_rowid='id');
      INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');`);
    native.close();
    db = await ObserverDB.create(path);
    expect(db.searchFts({ query: "audio" })[0].id).toBe(id);
    db.queueTranscription(id);
    stop = startTranscriptionWorker({ db, transcribe: async () => ({ text: "Migrated transcript" }) });
    await drain();
    await stop();
    db.close();
    db = await ObserverDB.create(path);
    expect(db.searchFts({ query: "Migrated" })[0]).toMatchObject({ id, transcript: "Migrated transcript", content: "[audio]" });
    db.query("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)");
  });
});
