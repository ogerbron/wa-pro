import { access } from "node:fs/promises";
import type { ObserverDB } from "./db.js";
import type { ChannelLogSink } from "./types.js";
import { registerObserverCleanup } from "./state.js";

/** Drains explicit requests independently of message capture. One worker per gateway. */
export function startTranscriptionWorker(params: {
  db: ObserverDB;
  transcribe: (filePath: string, mime: string) => Promise<{ text?: string }>;
  logger?: Pick<ChannelLogSink, "error">;
}): () => Promise<void> {
  const { db, transcribe, logger } = params;
  let stopped = false;
  let active: Promise<void> | undefined;
  db.recoverInterruptedTranscriptions();

  async function drain(): Promise<void> {
    while (!stopped) {
      const job = db.claimNextTranscription();
      if (!job) return;
      try {
        await access(job.mediaPath);
        const result = await transcribe(job.mediaPath, job.mediaMime ?? "audio/ogg");
        const text = result.text?.trim();
        if (!text) throw new Error("OpenClaw returned no transcript; check audio transcription configuration");
        db.completeTranscription(job.id, text);
      } catch (error) {
        db.failTranscription(job.id, error instanceof Error ? error.message : String(error));
      }
    }
  }

  function tick(): void {
    if (stopped || active) return;
    active = drain().catch(error => {
      logger?.error(`Observer transcription worker: ${String(error)}`);
    }).finally(() => { active = undefined; });
  }

  const timer = setInterval(tick, 1000);
  timer.unref();
  const unregisterCleanup = registerObserverCleanup(stop);
  tick();

  async function stop(): Promise<void> {
    stopped = true;
    clearInterval(timer);
    await active;
    unregisterCleanup();
  }
  return stop;
}
