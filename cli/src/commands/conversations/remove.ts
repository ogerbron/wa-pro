import { Args, Command, Flags } from "@oclif/core";
import { resolveDbPath, openDb } from "../../lib/db-reader.js";

export default class ConversationsRemove extends Command {
  static override description = "Permanently delete stored messages for a conversation across all accounts by default";

  static override examples = [
    "wa-pro conversations remove 33333333333@s.whatsapp.net",
    "wa-pro conversations remove 33333333333@s.whatsapp.net --account personal",
  ];

  static override args = {
    conversation: Args.string({ required: true, description: "Exact conversation JID" }),
  };

  static override flags = {
    account: Flags.string({ description: "Delete messages only for this observer account ID" }),
    db: Flags.string({ env: "WA_PRO_DB", description: "Path to observer SQLite database" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ConversationsRemove);
    const db = await openDb(resolveDbPath(flags.db));

    try {
      const count = db.removeConversation(args.conversation, flags.account);
      process.stdout.write(`Removed ${count} ${count === 1 ? "message" : "messages"} from ${args.conversation}.\n`);
    } finally {
      db.close();
    }
  }
}
