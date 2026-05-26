#!/usr/bin/env bash
#
# w3-app-branch-check.sh
#
# Verifies that the current branch in the app's workspace matches the
# allowed_branch_pattern from config/apps/<app_id>.yml and is not a blocked
# branch (e.g. main, master).
#
# Usage:
#   w3-app-branch-check.sh --app <app_id>
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

CONFIG="$W3_FORGE_ROOT/config/apps/${APP}.yml"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: App config not found: $CONFIG"
  exit 1
fi

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
PATTERN="$(section_value repo allowed_branch_pattern)"

if [[ -z "$WORKSPACE" ]]; then
  echo "ERROR: Missing paths.workspaces in $CONFIG"
  exit 1
fi

if [[ -z "$PATTERN" ]]; then
  echo "ERROR: Missing repo.allowed_branch_pattern in $CONFIG"
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
