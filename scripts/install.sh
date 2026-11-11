#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/openclaw.json}"
MIGRATE=""
for arg in "$@"; do
  case "$arg" in
    --migrate) MIGRATE=yes ;;
    --no-migrate) MIGRATE=no ;;
    --help|-h) echo 'Usage: install.sh [--migrate | --no-migrate]'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done
(cd "$PLUGIN_DIR" && npm ci --omit=dev --no-fund --no-audit)
(cd "$PLUGIN_DIR/cli" && npm ci --omit=dev --no-fund --no-audit)
if [ -z "$MIGRATE" ]; then
  if [ "$(node "$SCRIPT_DIR/manage-config.mjs" has-native "$CONFIG_PATH")" = yes ]; then
    read -rp 'Migrate existing WhatsApp config to WhatsApp Pro? [Y/n]: ' CHOICE
    case "$CHOICE" in [nN]|[nN][oO]) MIGRATE=no ;; *) MIGRATE=yes ;; esac
  else MIGRATE=no
  fi
fi
SAVED_CONFIG="$(mktemp)"
node "$SCRIPT_DIR/manage-config.mjs" prepare-install "$CONFIG_PATH" "$MIGRATE" "$SAVED_CONFIG"
restore_on_failure() {
  if [ -f "${CONFIG_PATH}.pre-whatsapp-pro.bak" ]; then
    cp "${CONFIG_PATH}.pre-whatsapp-pro.bak" "$CONFIG_PATH"
  fi
}
trap restore_on_failure ERR
# Current OpenClaw requires --force for local source installation and upgrades.
openclaw plugins install --force --accept-capabilities "$PLUGIN_DIR"
node "$SCRIPT_DIR/manage-config.mjs" finish-install "$CONFIG_PATH" "$SAVED_CONFIG"
trap - ERR
ln -sf "$PLUGIN_DIR/cli/bin/run.mjs" /usr/local/bin/wa-pro
echo "Installed. Run: bash $SCRIPT_DIR/setup.sh personal"
echo 'Then restart the gateway: openclaw gateway restart'
