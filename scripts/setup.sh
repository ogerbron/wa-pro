#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${STATE_DIR}/openclaw.json}"
ACCOUNT_ID="${1:-personal}"
echo "Configure account $ACCOUNT_ID:"
echo '  1) normal — agent replies and message logging'
echo '  2) observer — passive logging only'
read -rp 'Choose [1/2] (default: 2): ' CHOICE
case "$CHOICE" in 1|normal) MODE=normal ;; *) MODE=observer ;; esac
openclaw gateway stop 2>/dev/null || true
node "$SCRIPT_DIR/manage-config.mjs" account "$CONFIG_PATH" "$ACCOUNT_ID" "$MODE"
openclaw channels login --channel whatsapp-pro --account "$ACCOUNT_ID"
echo "Linked $MODE account $ACCOUNT_ID. Restart with: openclaw gateway restart"
