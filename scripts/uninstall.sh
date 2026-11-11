#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/openclaw.json}"
MIGRATE=""
RESTORE=""
KEEP_FILES=false
PURGE_CREDS=false
for arg in "$@"; do
  case "$arg" in
    --migrate) MIGRATE=yes ;;
    --no-migrate) MIGRATE=no ;;
    --restore-whatsapp) RESTORE=yes ;;
    --no-restore-whatsapp) RESTORE=no ;;
    --keep-files) KEEP_FILES=true ;;
    --purge-credentials) PURGE_CREDS=true ;;
    --help|-h) echo 'Usage: uninstall.sh [--migrate | --no-migrate] [--restore-whatsapp | --no-restore-whatsapp] [--keep-files] [--purge-credentials]'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done
if [ -z "$MIGRATE" ]; then
  if [ "$(node "$SCRIPT_DIR/manage-config.mjs" has-pro "$CONFIG_PATH")" = yes ]; then
    read -rp 'Migrate normal accounts back to WhatsApp? [Y/n]: ' CHOICE
    case "$CHOICE" in [nN]|[nN][oO]) MIGRATE=no ;; *) MIGRATE=yes ;; esac
  else MIGRATE=no
  fi
fi
openclaw gateway stop 2>/dev/null || true
# Save and migrate while the channel config still exists; native uninstall removes it.
node "$SCRIPT_DIR/manage-config.mjs" prepare-uninstall "$CONFIG_PATH" "$MIGRATE" "$RESTORE"
if $KEEP_FILES; then
  openclaw plugins uninstall whatsapp-pro --keep-files --force
else
  openclaw plugins uninstall whatsapp-pro --force
fi
if [ -L /usr/local/bin/wa-pro ]; then rm /usr/local/bin/wa-pro; fi
if $PURGE_CREDS; then
  rm -rf "${OPENCLAW_OAUTH_DIR:-${STATE_DIR}/credentials}/whatsapp" "${STATE_DIR}/oauth/whatsapp"
fi
echo 'Uninstalled. Restart with: openclaw gateway restart'
