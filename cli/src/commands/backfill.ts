import { Args, Command, Flags } from "@oclif/core";
import { resolveDbPath, openDb } from "../lib/db-reader.js";

export default class Backfill extends Command {
  static override description =
    "Request historical message backfill for a conversation.\n" +
    "Writes a backfill request to the observer DB. The running gateway's observer " +
    "monitor picks it up and calls Baileys' fetchMessageHistory().\n" +
    "The phone must be online for backfill to work.";

  static override examples = [
    "wa-pro backfill 4917600000001@s.whatsapp.net --account michael",
    "wa-pro backfill 120363406173840067@g.us --account michael --count 50 --requests 3",
  ];

  static override args = {
    conversation: Args.string({
      required: true,
      description: "Conversation JID to backfill (use 'wa-pro conversations' to find JIDs)",
    }),
  };

  static override flags = {
    account: Flags.string({
      required: true,
      description: "Observer account ID (must be connected to gateway)",
    }),
    count: Flags.integer({
      min: 1, max: 50,
      default: 50,
      description: "Messages per request (max 50)",
    }),
    requests: Flags.integer({
      min: 1,
      default: 1,
      description: "Number of sequential backfill requests",
    }),
    wait: Flags.integer({
      min: 0,
      default: 10,
      description: "Seconds to wait between requests",
    }),
    db: Flags.string({ env: "WA_PRO_DB", description: "Path to observer SQLite database" }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Backfill);
    const count = Math.min(flags.count, 50);

    const dbPath = resolveDbPath(flags.db);
    const db = await openDb(dbPath);

    try {
      // Check if the conversation exists in the DB
      const oldest = db.getOldestMessage(args.conversation, flags.account);
      if (!oldest) {
        this.error(
          `No messages found for conversation ${args.conversation} (account: ${flags.account}).\n` +
          "Backfill needs at least one message as an anchor point.\n" +
          "Send or receive a message in this conversation first.",
        );
      }

      for (let i = 0; i < flags.requests; i++) {
        if (i > 0) {
          process.stdout.write(`Waiting ${flags.wait}s before next request...\n`);
          await new Promise((resolve) => setTimeout(resolve, flags.wait * 1000));
          // Re-read oldest after wait (previous backfill may have added older messages)
        }

        const anchor = db.getOldestMessage(args.conversation, flags.account);
        if (!anchor) break;

        process.stdout.write(
          `Request ${i + 1}/${flags.requests}: fetching ${count} messages before ` +
          `${new Date(anchor.timestamp as number).toISOString()} in ${args.conversation}\n`,
        );

        // Write backfill request to DB — the observer monitor polls for these
        db.setSetting(`backfill.pending.${flags.account}.${Date.now()}`, JSON.stringify({
          accountId: flags.account,
          conversationId: args.conversation,
          count,
          anchorMessageId: anchor.message_id,
          anchorTimestamp: anchor.timestamp,
          requestedAt: Date.now(),
        }));
        db.flush();

        process.stdout.write(`  Backfill request queued.\n`);
      }

      process.stdout.write(
        `\nBackfill request(s) written to DB. The gateway's observer monitor will process them.\n` +
        `Phone must be online. Check progress:\n` +
        `  wa-pro stats --account ${flags.account}\n` +
        `  wa-pro history ${args.conversation} --account ${flags.account} --format table\n`,
      );
    } finally {
      db.close();
    }
  }
}
