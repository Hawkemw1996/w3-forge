#!/usr/bin/env bash
set -euo pipefail

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

CONFIG="/opt/w3forge-deploy/config/apps/${APP}.yml"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: App config not found: $CONFIG"
  exit 1
fi

WORKSPACE="$(grep -A20 '^paths:' "$CONFIG" | awk -F': ' '/workspaces:/ {print $2; exit}' | tr -d '"')"
PATTERN="$(grep -A20 '^repo:' "$CONFIG" | awk -F': ' '/allowed_branch_pattern:/ {print $2; exit}' | sed "s/^'//; s/'$//")"

if [[ -z "$WORKSPACE" ]]; then
  echo "ERROR: Missing paths.workspaces in $CONFIG"
  exit 1
fi

if [[ ! -d "$WORKSPACE/.git" ]]; then
  echo "ERROR: Workspace is not a git repo: $WORKSPACE"
  exit 1
fi

cd "$WORKSPACE"

BRANCH="$(git branch --show-current)"

if [[ "$BRANCH" == "main" || "$BRANCH" == "master" ]]; then
  echo "ERROR: Blocked branch: $BRANCH"
  exit 1
fi

if [[ ! "$BRANCH" =~ $PATTERN ]]; then
  echo "ERROR: Branch does not match allowed pattern."
  echo "App: $APP"
  echo "Branch: $BRANCH"
  echo "Pattern: $PATTERN"
  exit 1
fi

echo "OK: $APP branch approved: $BRANCH"
