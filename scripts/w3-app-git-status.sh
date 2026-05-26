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

WORKSPACE="$(awk '
  $0 == "paths:" {inside=1; next}
  inside && /^[^ ]/ {inside=0}
  inside && $1 == "workspaces:" {
    sub("^[ ]*workspaces: ", "")
    gsub("\"", "")
    print
    exit
  }
' "$CONFIG")"

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