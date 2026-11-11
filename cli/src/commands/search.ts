import { Args, Command, Flags } from "@oclif/core";
import { resolveDbPath, openDb } from "../lib/db-reader.js";
import { printOutput, type OutputFormat } from "../lib/output.js";

export default class Search extends Command {
  static override description = "Full-text search through observer messages";

  static override examples = [
    "wa-pro search hello",
    'wa-pro search "meeting tomorrow" --sender Alice --limit 20',
    "wa-pro search invoice --after 2026-01-01 --before 2026-03-01",
    'wa-pro search "project update" --group "Team Chat" --format table',
  ];

  static override args = {
    query: Args.string({ required: true, description: "Search query" }),
  };

  static override flags = {
    account: Flags.string({ description: "Filter by account ID" }),
    sender: Flags.string({ description: "Filter by sender (name, E.164 number, or JID)" }),
    group: Flags.string({ description: "Filter by group (name or JID)" }),
    after: Flags.string({ description: "Only messages after this date (ISO 8601)" }),
    before: Flags.string({ description: "Only messages before this date (ISO 8601)" }),
    limit: Flags.integer({ default: 50, description: "Max results (max 200)" }),
    db: Flags.string({ env: "WA_PRO_DB", description: "Path to observer SQLite database" }),
    format: Flags.string({
      options: ["json", "table"],
      default: "json",
      description: "Output format",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Search);
    const limit = Math.min(Math.max(flags.limit, 1), 200);

    const dbPath = resolveDbPath(flags.db);
    const db = await openDb(dbPath);

    try {
      const results = db.searchFts({
        query: args.query,
        accountId: flags.account,
        sender: flags.sender,
        group: flags.group,
        afterDate: flags.after ? new Date(flags.after).getTime() : undefined,
        beforeDate: flags.before ? new Date(flags.before).getTime() : undefined,
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
