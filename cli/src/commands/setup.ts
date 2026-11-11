import { readAccounts } from "../lib/account-reader.js";
import { Args, Command, Flags } from "@oclif/core";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type ConnectionState,
} from "baileys";

type OutputFormat = "qr" | "text" | "json";

const CREDENTIAL_DIRS = [
  join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"), "credentials", "whatsapp"),
  join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"), "oauth", "whatsapp"),
];

export default class Setup extends Command {
  static override description =
    "Link a WhatsApp account by generating a QR code for scanning.\n" +
    "Default output is a terminal QR code. Use --format text for the raw QR string\n" +
    "(useful for remote/API setups where the terminal isn't visible).";

  static override examples = [
    "wa-pro setup personal",
    "wa-pro setup personal --format text",
    "wa-pro setup personal --format json",
    "wa-pro setup personal --format qr --timeout 120",
    "wa-pro setup personal --force",
  ];

  static override args = {
    account: Args.string({
      required: true,
      description: "Account ID to link",
    }),
  };

  static override flags = {
    format: Flags.string({
      options: ["qr", "text", "json"],
      default: "qr",
      description: "Output format: qr (terminal), text (raw string), json (full details)",
    }),
    timeout: Flags.integer({
      default: 60,
      description: "Seconds to wait for QR generation",
    }),
    force: Flags.boolean({
      default: false,
      description: "Force re-link even if already connected",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Setup);
    const format = flags.format as OutputFormat;
    const accountId = args.account.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(accountId)) this.error("Account ID must use letters, digits, underscores or hyphens");

    const authDir = readAccounts(undefined).find(account => account.accountId === accountId)?.authDir ?? resolveAuthDir(accountId);

    // Check if already linked
    if (!flags.force && hasCredentials(authDir)) {
      const self = readSelfId(authDir);
      if (format === "json") {
        process.stdout.write(JSON.stringify({
          status: "already_linked",
          accountId,
          self,
          authDir,
        }, null, 2) + "\n");
      } else {
        process.stdout.write(`Account "${accountId}" is already linked (${self.e164 ?? self.jid ?? "unknown"}).\n`);
        process.stdout.write(`Use --force to re-link.\n`);
      }
      return;
    }

    // If forcing, clear existing credentials
    if (flags.force && existsSync(authDir)) {
      const { rmSync } = await import("node:fs");
      rmSync(authDir, { recursive: true, force: true });
    }

    mkdirSync(authDir, { recursive: true });

    const silentLogger = {
      level: "silent" as const,
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
      trace: () => {}, fatal: () => {},
      child: () => silentLogger,
    };

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    let qrResolve: ((qr: string) => void) | null = null;
    const qrPromise = new Promise<string>((resolve) => {
      qrResolve = resolve;
    });

    let connected = false;
    let stopped = false;
    let restarts = 0;
    let connectionError: string | undefined;
    let credsSave = Promise.resolve();
    const connect = (): ReturnType<typeof makeWASocket> => {
      const next = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, silentLogger as never),
        },
        version,
        logger: silentLogger as never,
        printQRInTerminal: false,
        browser: ["wa-pro", "setup", "1.0.0"],
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      next.ev.on("creds.update", () => {
        credsSave = credsSave.then(() => saveCreds()).catch(error => { connectionError = String(error); });
      });
      next.ev.on("connection.update", (update: Partial<ConnectionState>) => {
        if (update.qr && qrResolve) {
          qrResolve(update.qr);
          qrResolve = null;
        }
        if (update.connection === "open") connected = true;
        if (update.connection === "close") {
          const status = (update.lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          // A successful first pairing requires a fresh socket with the saved credentials.
          if (status === 515 && restarts++ < 2) {
            void credsSave.then(() => { if (!stopped) sock = connect(); }).catch(error => { connectionError = String(error); });
          } else {
            connectionError = String(update.lastDisconnect?.error ?? "Connection closed");
          }
        }
      });
      return next;
    };
    let sock = connect();

    // Wait for QR
    const timeoutMs = flags.timeout * 1000;
    let qrTimeout: ReturnType<typeof setTimeout> | undefined;
    const qrText = await Promise.race([
      qrPromise,
      new Promise<null>((resolve) => { qrTimeout = setTimeout(() => resolve(null), timeoutMs); }),
    ]);

    clearTimeout(qrTimeout);
    if (!qrText) {
      stopped = true;
      if (format === "json") {
        process.stdout.write(JSON.stringify({ status: "timeout", error: "QR code generation timed out" }) + "\n");
      } else {
        process.stderr.write("Timed out waiting for QR code.\n");
      }
      try { sock.ws?.close(); } catch { /* ignore */ }
      this.exit(1);
      return;
    }

    // Output QR
    if (format === "qr") {
      process.stdout.write("Scan this QR code in WhatsApp > Linked Devices > Link a Device:\n\n");
      const { default: qrTerminal } = await import("qrcode-terminal");
      qrTerminal.generate(qrText, { small: true }, (output: string) => process.stdout.write(output + "\n"));
      process.stdout.write("\nWaiting for scan...\n");
    } else if (format === "text") {
      process.stdout.write(qrText + "\n");
    } else {
      process.stdout.write(JSON.stringify({
        status: "qr_ready",
        accountId,
        qrText,
      }, null, 2) + "\n");
    }

    // Wait for connection (scan)
    const scanDeadline = Date.now() + 200_000; // 200s scan timeout
    while (!connected && !connectionError && Date.now() < scanDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    stopped = true;
    await credsSave;
    try { sock.ws?.close(); } catch { /* ignore */ }

    if (connected && !connectionError) {
      const self = readSelfId(authDir);
      if (format === "json") {
        process.stdout.write(JSON.stringify({
          status: "connected",
          accountId,
          self,
          authDir,
        }, null, 2) + "\n");
      } else {
        process.stdout.write(`\nLinked! Account "${accountId}" connected as ${self.e164 ?? self.jid ?? "unknown"}.\n`);
      }
    } else {
      const error = connectionError ?? "Timed out waiting for scan";
      if (format === "json") {
        process.stdout.write(JSON.stringify({ status: "failed", error }) + "\n");
      } else {
        process.stderr.write(`\nFailed: ${error}\n`);
      }
      this.exit(1);
    }
  }
}

function resolveAuthDir(accountId: string): string {
  for (const dir of CREDENTIAL_DIRS) {
    const candidate = join(dir, accountId);
    if (existsSync(join(candidate, "creds.json"))) {
      return candidate;
    }
  }
  return join(CREDENTIAL_DIRS[0], accountId);
}

function hasCredentials(authDir: string): boolean {
  try {
    const credsPath = join(authDir, "creds.json");
    if (!existsSync(credsPath)) return false;
    const data = JSON.parse(readFileSync(credsPath, "utf8"));
    return data.registered === true && typeof data.me?.id === "string";
  } catch {
    return false;
  }
}

function readSelfId(authDir: string): { e164: string | null; jid: string | null } {
  try {
    const raw = readFileSync(join(authDir, "creds.json"), "utf8");
    const parsed = JSON.parse(raw);
    const jid = typeof parsed?.me?.id === "string" ? parsed.me.id : null;
    const numberPart = jid?.split("@")[0]?.split(":")[0] ?? null;
    const e164 = numberPart && /^[0-9]+$/.test(numberPart) ? `+${numberPart}` : null;
    return { e164, jid };
  } catch {
    return { e164: null, jid: null };
  }
}
