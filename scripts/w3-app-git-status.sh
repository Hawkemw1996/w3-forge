#!/usr/bin/env bash
#
# w3-app-git-status.sh
#
# Reports git status for an app's configured workspace.
#
# Usage:
#   w3-app-git-status.sh --app <app_id>
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

# Validate config first.
"$W3_FORGE_ROOT/scripts/w3-app-config-validate.sh" --app "$APP" >/dev/null

CONFIG="$W3_FORGE_ROOT/config/apps/${APP}.yml"

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

WORKSPACE="$(section_value paths workspaces)"

if [[ ! -d "$WORKSPACE/.git" ]]; then
  echo "ERROR: Workspace is not a git repo: $WORKSPACE"
  exit 1
fi

cd "$WORKSPACE"

echo "W3 App Git Status"
echo "================="
echo "App: $APP"
echo "Workspace: $WORKSPACE"
echo "Branch: $(git branch --show-current)"
echo "Commit: $(git rev-parse --short HEAD 2>/dev/null || echo none-yet)"
echo

echo "Remote:"
git remote -v || true
echo

echo "Status:"
git status --short
echo

echo "Recent commits:"
git log --oneline -5 2>/dev/null || echo "No commits yet."
