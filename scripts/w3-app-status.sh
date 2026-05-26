#!/usr/bin/env bash
#
# w3-app-status.sh
#
# Reports a unified status view for an app: config, git workspace,
# branch guard, and service state.
#
# Usage:
#   w3-app-status.sh --app <app_id>
#
set -euo pipefail

W3_FORGE_ROOT="${W3_FORGE_ROOT:-/opt/w3forge-deploy}"

APP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP="${2:-}"
      shift 2
      ;;
    *)
      echo "ERROR: Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$APP" ]]; then
  echo "ERROR: Missing --app <app_id>"
  exit 1
fi

# Validate config first; abort on any ERROR.
"$W3_FORGE_ROOT/scripts/w3-app-config-validate.sh" --app "$APP" >/dev/null

CONFIG="$W3_FORGE_ROOT/config/apps/${APP}.yml"

# Top-level scalar extractor.
top_level_value() {
  local key="$1"
  awk -v key="$key" '
    $0 ~ "^"key":" {
      sub("^"key":[ \t]*", "")
      gsub(/^["'\'']|["'\'']$/, "")
      print
      exit
    }
  ' "$CONFIG"
}

# Section-aware nested scalar extractor.
section_value() {
  local section="$1"
  local key="$2"
  awk -v section="$section" -v key="$key" '
    $0 == section ":" { inside=1; next }
    inside && /^[^ \t#]/ { inside=0 }
    inside {
      if (match($0, "^[ \t]+"key":")) {
        line = $0
        sub("^[ \t]+"key":[ \t]*", "", line)
        gsub(/^["'\'']|["'\'']$/, "", line)
        print line
        exit
      }
    }
  ' "$CONFIG"
}

NAME="$(top_level_value name)"
WORKSPACE="$(section_value paths workspaces)"
SERVICE="$(section_value service name)"

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
  (
    cd "$WORKSPACE"
    echo "Branch: $(git branch --show-current)"
    echo "Commit: $(git rev-parse --short HEAD 2>/dev/null || echo none-yet)"
    git status --short
  )
else
  echo "Workspace is not a git repo: $WORKSPACE"
fi
echo

echo "Branch Guard"
echo "------------"
"$W3_FORGE_ROOT/scripts/w3-app-branch-check.sh" --app "$APP" || true
echo

echo "Service"
echo "-------"
if [[ -z "$SERVICE" ]]; then
  echo "Not configured"
elif ! command -v systemctl >/dev/null 2>&1; then
  echo "Not installed"
else
  # Classify cleanly into one of: Active / Inactive / Not installed.
  # Use list-unit-files to detect whether the unit exists at all.
  if systemctl list-unit-files "${SERVICE}.service" 2>/dev/null | grep -q "^${SERVICE}.service"; then
    STATE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
    case "$STATE" in
      active)
        echo "Active"
        ;;
      inactive|failed|activating|deactivating)
        echo "Inactive"
        ;;
      *)
        echo "Inactive"
        ;;
    esac
  else
    echo "Not installed"
  fi
fi
