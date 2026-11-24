import { Command, Flags } from "@oclif/core";
import { resolveDbPath, openDb } from "../lib/db-reader.js";
import { printOutput, type OutputFormat } from "../lib/output.js";

export default class Contacts extends Command {
  static override description = "List known contacts and groups from the observer database";

  static override examples = [
    "wa-pro contacts",
    "wa-pro contacts --groups",
    "wa-pro contacts --account michael --format table",
  ];

  static override flags = {
    account: Flags.string({ description: "Filter by account ID" }),
    groups: Flags.boolean({ description: "Show only groups", default: false }),
    people: Flags.boolean({ description: "Show only people (no groups)", default: false }),
    limit: Flags.integer({ default: 100, description: "Max results" }),
    db: Flags.string({ env: "WA_PRO_DB", description: "Path to observer SQLite database" }),
    format: Flags.string({
      options: ["json", "table"],
      default: "json",
      description: "Output format",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Contacts);

    const dbPath = resolveDbPath(flags.db);
    const db = await openDb(dbPath);

    try {
      const isGroup = flags.groups ? true : flags.people ? false : undefined;
      const contacts = db.listContacts({
        accountId: flags.account,
        isGroup,
        limit: flags.limit,
      });

      printOutput(contacts, flags.format as OutputFormat, [
        { key: "jid", header: "JID", width: 35 },
        { key: "push_name", header: "Name", width: 20 },
        { key: "business_name", header: "Business", width: 20 },
        { key: "phone", header: "Phone", width: 16 },
        { key: "is_group", header: "Group", width: 6 },
        { key: "group_subject", header: "Subject", width: 25 },
        { key: "account_id", header: "Account", width: 12 },
      ]);
    } finally {
      db.close();
    }
  }
}
