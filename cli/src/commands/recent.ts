import { Command, Flags } from "@oclif/core";
import { resolveDbPath, openDb } from "../lib/db-reader.js";
import { printOutput, type OutputFormat } from "../lib/output.js";

export default class Recent extends Command {
  static override description = "Show recent observer messages";

  static override examples = [
    "wa-pro recent",
    "wa-pro recent --sender Alice --limit 20",
    "wa-pro recent --conversation 4917600000001@s.whatsapp.net",
    "wa-pro recent --account personal --format table",
  ];

  static override flags = {
    conversation: Flags.string({ description: "Filter by conversation JID" }),
    sender: Flags.string({ description: "Filter by sender (name, E.164 number, or JID)" }),
    account: Flags.string({ description: "Filter by observer account ID" }),
    limit: Flags.integer({ default: 50, description: "Max results (max 200)" }),
    db: Flags.string({ env: "WA_PRO_DB", description: "Path to observer SQLite database" }),
    format: Flags.string({
      options: ["json", "table"],
      default: "json",
      description: "Output format",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Recent);
    const limit = Math.min(Math.max(flags.limit, 1), 200);

    const dbPath = resolveDbPath(flags.db);
    const db = await openDb(dbPath);

    try {
      const results = db.getRecent({
        conversationId: flags.conversation,
        sender: flags.sender,
        accountId: flags.account,
        limit: limit,
      });

      const filtered = results;

      printOutput(filtered, flags.format as OutputFormat, [
        { key: "account_id", header: "Account", width: 12 },
        { key: "timestamp", header: "Time", width: 24 },
        { key: "sender_name", header: "Sender", width: 20 },
        { key: "group_name", header: "Group", width: 20 },
        { key: "content", header: "Content", width: 60 },
      ]);
    } finally {
      db.close();
    }
  }
}
