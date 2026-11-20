# WhatsApp Pro — OpenClaw Plugin

A fully independent WhatsApp channel plugin for [OpenClaw](https://openclaw.ai) that passively logs all WhatsApp messages to a queryable SQLite database while running the standard agent pipeline alongside it.

## Features

- **Independent channel** — registers as `whatsapp-pro`, replaces the built-in WhatsApp plugin with identical agent functionality plus observer capabilities
- **Full message capture** — every message (inbound, outbound, agent replies, reactions, edits, deletes) is logged at the Baileys wire level for all accounts
- **Observer-only accounts** — dedicated passive listeners that never send, never trigger agent sessions, and never create conversations
- **`wa-pro` CLI** — standalone oclif CLI for querying messages, managing accounts, and configuring observer settings
- **Agent skill** — automatically teaches the OpenClaw agent about the CLI so it can query message history on demand via `exec`
- **Per-account configuration** — recording mode, allowlist, blocklist, and retention are configurable per account with global defaults
- **Three recording modes** — control what gets stored and what the agent/CLI can retrieve
- **History sync** — automatically captures historical messages on connect via Baileys' full history sync
- **On-demand backfill** — request older messages for specific conversations via `wa-pro backfill`
- **Contact directory** — automatically collects contact names and group metadata from WhatsApp events
- **FTS5 search** — full-text search index for fast queries on large message databases

The channel runtime is based on the official WhatsApp implementation at OpenClaw `v2026.11.3`. See [UPSTREAM.md](./UPSTREAM.md) for provenance and validation details.

## Prerequisites

- OpenClaw installed and running (`>=2026.11.3`)
- Node.js 24.16+ on the 24.x line, or 26.1+ (matching OpenClaw 2026.11.3)
- A WhatsApp account to link (personal or business)

## Quick Start

```bash
# 1. Clone
git clone https://github.com/FroeMic/wa-pro.git
cd wa-pro

# 2. Install (backs up config, disables built-in whatsapp, installs wa-pro CLI)
bash scripts/install.sh

# 3. Setup an account
bash scripts/setup.sh personal        # interactive: choose normal or observer mode
# Scan the QR code with WhatsApp > Linked Devices > Link a Device

# 4. Start
openclaw gateway restart

# 5. Verify
wa-pro stats
wa-pro conversations --format table
```

## Install

```bash
bash scripts/install.sh [--migrate | --no-migrate]
```

| Flag | Description |
|------|-------------|
| `--migrate` | Migrate existing `channels.whatsapp` accounts and policies to `whatsapp-pro` |
| `--no-migrate` | Start fresh — disable built-in whatsapp without copying config |
| *(none)* | Prompted interactively if existing whatsapp config is found |

The install script:
1. Stops the gateway through `openclaw gateway stop --force` before changing dependencies or configuration; aborts if stopping fails
2. Installs root and CLI production dependencies
3. Builds the JavaScript runtime and setup entries in `dist/` and creates an npm package archive; aborts before config migration if either fails
4. Backs up `openclaw.json` (`.pre-whatsapp-pro.bak`)
5. Records whether the built-in whatsapp plugin was previously enabled
6. Disables the official whatsapp plugin explicitly and removes its channel config
7. Installs the archive via `openclaw plugins install --force --accept-capabilities <archive.tgz>`
8. Links the `wa-pro` executable to `/usr/local/bin`
9. Uses the CLI's own TypeScript loader; no global `tsx` install is needed

Existing config (accounts, policies, observer settings) is preserved across reinstalls.
The gateway stays stopped for account setup; restart it afterward with `openclaw gateway restart`.

If installation reports "requires exclusive offline state ownership", stop the gateway through its service owner and wait for shutdown before retrying. For a managed service, run `openclaw gateway stop --force`. If it cannot stop, inspect `openclaw gateway status --deep` and stop the service using the supervisor shown there.

If an older installer reports `Refusing to move hardlinked file` under the installed plugin's `node_modules`, rerun this updated script. It uses OpenClaw's supported npm archive installation path, which handles package-manager dependency hardlinks during upgrades. No installed dependency files or recovery backups need to be removed.

## Account Setup

```bash
bash scripts/setup.sh <accountId>
```

You'll be prompted to choose:
1. **Normal** — full agent pipeline (receives messages, agent replies, DM policy enforced)
2. **Observer** — passive logging only (no sessions, no replies, no sends)

Both account types log all messages to the observer database. The difference is whether the account participates in the agent pipeline.

You can set up multiple accounts (e.g., a personal phone as observer + a business phone as normal).

## Uninstall

```bash
bash scripts/uninstall.sh [OPTIONS]
```

| Flag | Description |
|------|-------------|
| `--migrate` | Migrate accounts back to `channels.whatsapp` (observer-only accounts excluded) |
| `--no-migrate` | Remove config without migrating back |
| `--restore-whatsapp` | Force re-enable built-in whatsapp plugin |
| `--no-restore-whatsapp` | Don't re-enable built-in whatsapp |
| `--purge-credentials` | Delete WhatsApp Web credentials (`~/.openclaw/credentials/whatsapp/`) |
| `--keep-files` | Keep plugin files on disk |

Without `--restore-whatsapp` / `--no-restore-whatsapp`, the script auto-detects from saved state.

## CLI Reference

### Query Commands

All query commands output JSON by default. Use `--format table` for human-readable output.

```bash
# Full-text search
wa-pro search "<query>" [--conversation <jid>] [--account <id>] [--sender <name>] [--group <name>] [--after <date>] [--before <date>] [--limit <N>]

# All visible messages in one conversation (newest first)
wa-pro search '*' --conversation 3333333@s.whatsapp.net

# Chronological conversation history (oldest first, max 500)
wa-pro history <conversation-jid> [--account <id>] [--after <date>] [--before <date>] [--limit <N>]

# Recent messages (newest first)
wa-pro recent [--conversation <jid>] [--sender <name>] [--account <id>] [--limit <N>]

# List conversations with message counts and contact names
wa-pro conversations [--account <id>] [--limit <N>]

# Permanently delete stored messages for a conversation (all accounts by default)
wa-pro conversations remove <conversation-jid> [--account <id>]

# Aggregate statistics with optional grouping
wa-pro stats [--account <id>] [--after <date>] [--group-by sender|group|day|hour]
```

### Backfill Commands

```bash
# Request older messages for a conversation (phone must be online)
wa-pro backfill <conversation-jid> --account <id> [--count <N>] [--requests <N>] [--wait <seconds>]

# Backfill all conversations for an account
wa-pro conversations --account michael --format json | \
  jq -r '.[].conversationId' | \
  while read jid; do wa-pro backfill "$jid" --account michael --requests 3 --wait 10; done
```

### Account & Contact Commands

```bash
# List all accounts with role, linked status, policies, and message counts
wa-pro accounts [--format table]

# List known contacts and groups
wa-pro contacts [--account <id>] [--groups] [--people] [--format table]
```

### Voice note transcription

Voice notes are recorded as audio files by the existing observer workflow. Recording a note does not queue or run observer transcription. Request transcription explicitly using the numeric `id` from `wa-pro recent` or `wa-pro history` JSON output:

```bash
wa-pro recent --account personal
wa-pro transcribe 123
wa-pro history 4917600000001@s.whatsapp.net --account personal
wa-pro search "words from the recording"
```

`wa-pro transcribe <id>` queues the request in SQLite and returns immediately with the message and its status. A separate background worker in the running gateway polls the queue every second and processes one file at a time. It calls `api.runtime.mediaUnderstanding.transcribeAudioFile({ filePath, cfg: api.config, mime })`, using OpenClaw's configured audio providers, models and credentials. Audio understanding must be enabled and a working transcription provider or CLI must be available. Requests queued while the gateway is stopped remain pending until it starts. `--db` and `WA_PRO_DB` must point to the database used by that gateway.

Transcription enriches the original row with `transcript`, `transcription_status` (`none`, `pending`, `processing`, `completed`, `failed`), `transcription_error` and `transcribed_at` (Unix milliseconds). The original `content`, recording path, sender, timestamp and message ID are preserved. Transcripts are included in JSON history/recent/search results and indexed for full-text search. Table output continues to show the original message content.

Repeat `wa-pro transcribe <id>` to retry a failed request. Pending, processing and completed requests are not duplicated. Missing files, provider failures and empty results are recorded as failures; the worker continues with other requests. Interrupted jobs are returned to pending when the gateway worker restarts. Run one gateway transcription worker per database; an interrupted provider call may run again after a crash.

Existing databases migrate in place, including their search index. Observer transcription does not change the normal account agent pipeline's existing audio handling. Retention continues to remove message rows and their transcripts while leaving downloaded files on disk.

### Observer Config Commands

Settings are stored in the observer database and take effect on the next query or message. Retention pruning runs every five seconds for each connected account. No gateway restart is needed.

All config commands support `--account <id>` for per-account overrides. Without `--account`, they set/show global defaults. Use `--reset --account <id>` to remove an override and fall back to global.

```bash
# View settings (global or per-account)
wa-pro config show [--account <id>]

# Recording/retrieval mode
wa-pro config mode [<mode>] [--account <id>] [--reset]

# Allowlist management
wa-pro config allowlist [list|add|remove|clear] [<entry>] [--account <id>] [--reset]

# Blocklist management
wa-pro config blocklist [list|add|remove|clear] [<entry>] [--account <id>] [--reset]

# Retention period (days, 0 = forever)
wa-pro config retention [<days>] [--account <id>] [--reset]
```

## Observer Modes

| Mode | What's Recorded | What's Queryable |
|------|----------------|-----------------|
| `record-all-retrieve-all` *(default)* | All messages | All messages |
| `record-all-retrieve-filtered` | All messages | Only messages matching allowlist/blocklist |
| `record-filtered-retrieve-filtered` | Only allowed messages | Only allowed messages |

Modes are configurable per account with global defaults:

```bash
wa-pro config mode record-all-retrieve-all                          # global default
wa-pro config mode record-all-retrieve-filtered --account michael   # per-account override
wa-pro config mode --reset --account michael                        # remove override
```

These modes are **independent** from the WhatsApp channel's `dmPolicy` / `allowFrom` settings, which control agent session access.

## Configuration

### openclaw.json — Account Config

Account configuration uses the same shape as the native WhatsApp plugin:

```json
{
  "channels": {
    "whatsapp-pro": {
      "accounts": {
        "personal": {
          "enabled": true,
          "dmPolicy": "pairing",
          "groupPolicy": "allowlist",
          "allowFrom": ["+4917600000001"]
        },
        "michael": {
          "enabled": true
        }
      },
      "observer": {
        "accounts": ["michael"]
      }
    }
  }
}
```

### Observer Database — Runtime Settings

Observer settings (mode, filters, retention) live in the SQLite database at `~/.openclaw/whatsapp-observer/messages.db`. Manage via `wa-pro config` commands. Settings are scoped:

- **Global defaults** — apply to all accounts unless overridden
- **Per-account overrides** — take precedence over global for that account

The gateway and CLI share a native SQLite database in WAL mode. Existing sql.js databases are opened in place, and contacts and FTS indexes are migrated automatically. `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` are honored by the CLI and scripts. Retention removes message rows; downloaded media files remain on disk.

On first startup, global defaults are seeded from `openclaw.json` if present. After that, the database is the source of truth.

## Architecture

```
openclaw-whatsapp-observer-plugin/
  index.ts                    # Plugin entry point
  openclaw.plugin.json        # Plugin manifest (channels, skills)
  src/
    channel.ts                # Channel plugin (adapters, gateway, observer tap)
    channel-config.ts         # Zod schema + typed config accessor
    observer-config.ts        # Observer config parsing
    observer/
      monitor.ts              # Baileys listener + message processing (all accounts)
      db.ts                   # SQLite database (messages + contacts + scoped settings + FTS5)
      filter.ts               # Allowlist/blocklist filtering
      types.ts                # Type definitions
    inbound/
      monitor.ts              # Normal account Baileys listener (with observer tap)
    auto-reply/               # Agent pipeline (unchanged from upstream)
  cli/
    bin/run.mjs               # CLI executable with its own TypeScript loader
    bin/run.ts                # oclif entry point
    src/
      commands/               # oclif commands
        search.ts, recent.ts, history.ts, conversations.ts, stats.ts
        accounts.ts, contacts.ts, backfill.ts
        config/               # show, mode, allowlist, blocklist, retention
      lib/                    # Shared utilities
  skills/
    wa-pro/SKILL.md           # Agent skill definition
  scripts/
    install.sh                # Install with config migration
    uninstall.sh              # Uninstall with config restoration
    setup.sh                  # Account setup (normal/observer)
  test/                       # Compatibility, storage, capture, CLI, and migration tests
```

### Message Flow

**All accounts** (observer and normal) log messages at the Baileys wire level:

```
WhatsApp --> Baileys messages.upsert --> processObserverMessage() --> SQLite DB
```

**Normal accounts** also run the agent pipeline in parallel:

```
WhatsApp --> Baileys --> Observer DB tap --> pipeline --> Agent --> reply
```

**Observer accounts** skip the pipeline entirely:

```
WhatsApp --> Baileys --> Observer DB (+ optional media) --> done
```

### Safety Model

Observer accounts are prevented from sending messages at three layers:

1. **Socket send guard** — observer sockets reject all `sendMessage` calls
2. **No agent pipeline** — observer messages bypass session creation entirely
3. **`message_sending` hook** — a lifecycle hook blocks any outbound attempt on observer accounts (priority 9999)

## Message Types

| `message_type` | Description | `ref_message_id` |
|---|---|---|
| `message` | Regular text or media message | — |
| `reaction` | Emoji reaction | Original message ID |
| `poll` | Poll creation | — |
| `edit` | Edited message | Original message ID |
| `delete` | Deletion/revoke | Deleted message ID |

## Development

```bash
# Install development dependencies
npm ci
(cd cli && npm ci)

# Build the JavaScript runtime and setup entries for installation
npm run build

# Check storage types, SDK exports, and TypeScript syntax against OpenClaw 2026.11.3
npm run check

# Run unit and integration tests
npm test

# Test CLI locally
node cli/bin/run.mjs --help
node cli/bin/run.mjs search "hello" --format table

# Quick deploy to server (without full reinstall)
git pull
npm run build
cp -r . ~/.openclaw/extensions/whatsapp-pro/
openclaw gateway restart
```

Copied and packaged installations load `dist/index.js` and `dist/setup-entry.js`.
`npm pack` runs the build automatically and includes `dist/`, even though generated output is ignored by Git.

## Reset Database

To clear all messages, contacts, and settings and start fresh:

```bash
openclaw gateway stop
rm -f ~/.openclaw/whatsapp-observer/messages.db{,-wal,-shm}
openclaw gateway restart
```

The DB is recreated automatically on gateway startup. Stop the gateway before resetting storage; SQLite also uses `messages.db-wal` and `messages.db-shm` while open.

## License

MIT — see [LICENSE.md](./LICENSE.md).
