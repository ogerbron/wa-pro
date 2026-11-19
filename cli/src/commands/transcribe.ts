import { Args, Command, Flags } from "@oclif/core";
import { resolveDbPath, openDb } from "../lib/db-reader.js";
import { printOutput } from "../lib/output.js";

export default class Transcribe extends Command {
  static override description =
    "Queue transcription of a recorded audio message by its numeric database row ID.\n" +
    "The running gateway's background worker uses OpenClaw's configured audio engine.\n" +
    "Repeat the command to retry a failed job; completed or active jobs are left intact.";

  static override examples = ["wa-pro transcribe 123"];

  static override args = {
    id: Args.integer({ required: true, min: 1, description: "Message row ID from wa-pro recent or history (JSON)" }),
  };

  static override flags = {
    db: Flags.string({ env: "WA_PRO_DB", description: "Path to observer SQLite database" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Transcribe);
    const db = await openDb(resolveDbPath(flags.db));
    try {
      printOutput(db.queueTranscription(args.id), "json");
    } finally {
      db.close();
    }
  }
}
