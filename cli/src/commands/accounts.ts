import { Command, Flags } from "@oclif/core";
import { resolveDbPath, openDb } from "../lib/db-reader.js";
import { readAccounts } from "../lib/account-reader.js";
import { printOutput, type OutputFormat } from "../lib/output.js";

export default class Accounts extends Command {
  static override description = "List configured WhatsApp Pro accounts with status";

  static override examples = [
    "wa-pro accounts",
    "wa-pro accounts --format table",
  ];

  static override flags = {
    db: Flags.string({ env: "WA_PRO_DB", description: "Path to observer SQLite database" }),
    format: Flags.string({
      options: ["json", "table"],
      default: "json",
      description: "Output format",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Accounts);

    let db;
    try {
      const dbPath = resolveDbPath(flags.db);
      db = await openDb(dbPath);
    } catch {
      db = undefined;
    }

    try {
      const accounts = readAccounts(db);

      printOutput(accounts, flags.format as OutputFormat, [
        { key: "accountId", header: "Account", width: 15 },
        { key: "name", header: "Name", width: 15 },
        { key: "role", header: "Role", width: 10 },
        { key: "enabled", header: "Enabled", width: 8 },
        { key: "linked", header: "Linked", width: 8 },
        { key: "dmPolicy", header: "DM Policy", width: 12 },
        { key: "groupPolicy", header: "Group Policy", width: 14 },
        { key: "messageCount", header: "Messages", width: 10 },
        { key: "lastMessageAt", header: "Last Message", width: 24 },
      ]);
    } finally {
      db?.close();
    }
  }
}
