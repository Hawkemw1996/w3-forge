#!/usr/bin/env bash
set -euo pipefail

APP="${2:-}"

if [[ "${1:-}" != "--app" || -z "$APP" ]]; then
  echo "ERROR: Usage: $0 --app <app_id>"
  exit 1
fi

CONFIG="/opt/w3forge-deploy/config/apps/${APP}.yml"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: App config not found: $CONFIG"
  exit 1
fi

value_after() {
  local section="$1"
  local key="$2"
  awk -v section="$section" -v key="$key" '
    $0 == section ":" {inside=1; next}
    inside && /^[^ ]/ {inside=0}
    inside && $1 == key ":" {
      sub("^[ ]*" key ": ", "")
      gsub("\"", "")
      print
      exit
    }
  ' "$CONFIG"
}

NAME="$(awk -F': ' '/^name:/ {print $2; exit}' "$CONFIG")"
WORKSPACE="$(value_after paths workspaces)"
SERVICE="$(value_after service name)"

echo "W3 App Status"
echo "============="
echo "App: $APP"
echo "Name: $NAME"
echo "Config: $CONFIG"
echo "Workspace: $WORKSPACE"
echo

echo "Git"
echo "---"
if [[ -d "$WORKSPACE/.git" ]]; then
  cd "$WORKSPACE"
  echo "Branch: $(git branch --show-current)"
  echo "Commit: $(git rev-parse --short HEAD 2>/dev/null || echo none-yet)"
  git status --short
else
  echo "Workspace is not a git repo: $WORKSPACE"
fi
echo

echo "Branch Guard"
echo "------------"
/opt/w3forge-deploy/scripts/w3-app-branch-check.sh --app "$APP"
echo

echo "Service"
echo "-------"
if [[ -n "$SERVICE" ]]; then
  systemctl is-active "$SERVICE" 2>/dev/null || echo "Service not active or not installed: $SERVICE"
else
  echo "No service configured."
fi
