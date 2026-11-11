import { Args, Command, Flags } from "@oclif/core";
import { resolveDbPath, openDb } from "../lib/db-reader.js";
import { printOutput, type OutputFormat } from "../lib/output.js";

export default class History extends Command {
  static override description = "Show chronological message history for a conversation";

  static override examples = [
    "wa-pro history 4917600000001@s.whatsapp.net",
    "wa-pro history 120363406173840067@g.us --limit 100",
    "wa-pro history 4917600000001@s.whatsapp.net --after 2026-03-01 --format table",
    "wa-pro history 120363406173840067@g.us --account personal",
  ];

  static override args = {
    conversation: Args.string({
      required: true,
      description: "Conversation JID (e.g., 4917600000001@s.whatsapp.net or 120363...@g.us)",
    }),
  };

  static override flags = {
    account: Flags.string({ description: "Filter by observer account ID" }),
    after: Flags.string({ description: "Only messages after this date (ISO 8601)" }),
    before: Flags.string({ description: "Only messages before this date (ISO 8601)" }),
    limit: Flags.integer({ default: 100, description: "Max messages (max 500)" }),
    db: Flags.string({ env: "WA_PRO_DB", description: "Path to observer SQLite database" }),
    format: Flags.string({
      options: ["json", "table"],
      default: "json",
      description: "Output format",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(History);
    const limit = Math.min(Math.max(flags.limit, 1), 500);

    const dbPath = resolveDbPath(flags.db);
    const db = await openDb(dbPath);

    try {
      const results = db.getHistory({
        conversationId: args.conversation,
        accountId: flags.account,
        afterDate: flags.after ? new Date(flags.after).getTime() : undefined,
        beforeDate: flags.before ? new Date(flags.before).getTime() : undefined,
        limit: limit,
      });

      const filtered = results;

      printOutput(filtered, flags.format as OutputFormat, [
        { key: "account_id", header: "Account", width: 12 },
        { key: "timestamp", header: "Time", width: 24 },
        { key: "sender_name", header: "Sender", width: 20 },
        { key: "content", header: "Content", width: 80 },
      ]);
    } finally {
      db.close();
    }
  }
}
