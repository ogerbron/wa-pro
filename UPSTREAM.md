# OpenClaw compatibility review

This fork targets **OpenClaw 2026.11.3**. Its channel runtime is based on the
production dependency graph of
[`extensions/whatsapp` at `v2026.11.3`](https://github.com/openclaw/openclaw/tree/v2026.11.3/extensions/whatsapp).
The upstream MIT notice is retained in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
The plugin runs its own channel implementation and does not require the official
WhatsApp plugin to be enabled.

The March runtime imported removed SDK facades throughout authorization,
routing, replies, config access, and socket management. Updating imports alone
would not preserve the current contracts. The runtime update retains the
`whatsapp-pro` channel/config/session identity and the existing native
`credentials/whatsapp/<account>` directory. Baileys matches upstream at
`7.0.0-rc14`. Observer settings and the standalone CLI remain plugin-owned.

## Findings addressed

- Channel schemas are published in `channelConfigs` for cold discovery/setup.
  The runtime schema extends native validation with observer settings and
  installation metadata. Account setup preserves channel-level settings.
- Registration does not open storage. Services/account startup await DB readiness;
  an initialization failure cannot route an observer into the normal pipeline.
- Capture listeners attach when sockets are created, before connection/history
  events. Both normal and observer sockets capture history, live traffic,
  outbound messages, contacts, reactions, edits, and revokes. Observer socket
  sends are rejected directly, in addition to pipeline isolation and the outbound hook.
- SQLite uses Node's built-in implementation with WAL and a busy timeout.
  The former sql.js snapshot/export mechanism could discard other processes'
  writes and could not see live CLI settings or queued backfills. Existing SQLite
  files open in place; legacy contacts and FTS indexes migrate automatically.
- Retrieval applies per-account DB settings before limits, search, and aggregates.
  Contacts/conversations remain account-scoped; retention runs per account.
  Revoke/edit records do not collide with originals, outgoing messages record
  the local sender, and unresolved LIDs are not converted to phone numbers.
- Both account types process queued backfills. Gateway methods use the host's
  `{ params, respond }` contract, and history requests preserve anchor direction.
- CLI execution owns its TypeScript/QR dependencies. Setup handles Baileys'
  restart-required pairing response and waits for credential persistence.
- Install/uninstall parse JSON5, preserve prior enablement across reinstalls,
  explicitly disable the official plugin, and migrate account config before
  native uninstall removes it. Setup can switch an observer back to normal.

## Verification

- `npm test`: storage, separate-process CLI operations, wire event capture,
  observer send protection/startup, pairing restart, and config migration tests.
- `npm run check`: strict storage type checking, syntax/transpilation checks,
  manifest/runtime schema equality, and actual named exports from the target SDK.
- Root and CLI lockfiles accept `npm ci --dry-run --ignore-scripts`.
- `bash -n scripts/install.sh scripts/setup.sh scripts/uninstall.sh`.
- OpenClaw 2026.11.3 native config validation: valid, no warnings.
- Native local plugin install/list: loaded, no diagnostics.
- Isolated gateway smoke test with every WhatsApp account disabled: HTTP startup
  included `whatsapp-pro`, the observer service created its database, and SIGTERM
  shut down without plugin errors. The user's active configuration was not used.

## Verification limits

Live QR scanning, reconnects to WhatsApp, delivery, full history availability,
media downloads, and phone-backed backfill need linked devices. Tests simulate
those socket events; the gateway smoke test deliberately leaves accounts disabled.

The published host omits TypeScript declarations for several runtime-only SDK
subpaths used by its official WhatsApp source. A whole-repository
`tsc --noEmit` still reports those missing declarations and related inference
errors. `npm run check` validates the actual runtime exports and transpilation
instead of supplying permissive declarations or disabling strict checks globally;
`npm run check:db` strictly checks the storage implementation.
