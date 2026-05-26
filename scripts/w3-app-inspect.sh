#!/usr/bin/env bash
#
# w3-app-inspect.sh
#
# Read-only repository and app inspection for W3 Forge v0.2.0.
# Part of the v0.2.0 workflow control foundation.
#
# Usage:
#   w3-app-inspect.sh --app <app_id>
#
# Behavior:
#   - Validates the app config first (calls w3-app-config-validate.sh).
#   - Prints app identity, config path, workspace path.
#   - Prints current branch, current commit, remotes, recent 5 commits.
#   - Prints changed files (short status).
#   - Prints script inventory under $W3_FORGE_ROOT/scripts/.
#   - Prints config inventory under $W3_FORGE_ROOT/config/apps/.
#   - Prints workspace health.
#   - Never modifies any file. Never deploys. Read-only.
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

# Validate config first; abort if invalid.
"$W3_FORGE_ROOT/scripts/w3-app-config-validate.sh" --app "$APP" >/dev/null

# ---------------------------------------------------------------------------
# YAML helpers (section-aware, identical contract to v0.1.1 scripts)
# ---------------------------------------------------------------------------

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
VERSION="$(top_level_value version)"
WORKSPACE="$(section_value paths workspaces)"

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

echo "W3 App Inspect"
echo "=============="
echo "App: $APP"
echo "Name: ${NAME:-(unset)}"
echo "Config: $CONFIG"
echo "Workspace: ${WORKSPACE:-(unset)}"
if [[ -n "${VERSION:-}" ]]; then
  echo "Config version: $VERSION"
fi
echo

# ---------------------------------------------------------------------------
# Git inspection
# ---------------------------------------------------------------------------

echo "Git"
echo "---"
if [[ -z "${WORKSPACE:-}" ]]; then
  echo "WARN:  paths.workspaces is empty; cannot inspect git state."
elif [[ ! -d "$WORKSPACE" ]]; then
  echo "WARN:  Workspace path does not exist: $WORKSPACE"
elif [[ ! -d "$WORKSPACE/.git" ]]; then
  echo "WARN:  Workspace is not a git repo: $WORKSPACE"
else
  (
    cd "$WORKSPACE"
    echo "Branch: $(git branch --show-current)"
    echo "Commit: $(git rev-parse --short HEAD 2>/dev/null || echo none-yet)"
    echo
    echo "Remotes:"
    if git remote -v | grep -q .; then
      git remote -v
    else
      echo "(no remotes configured)"
    fi
    echo
    echo "Recent commits (5):"
    if ! git log --oneline -5 2>/dev/null; then
      echo "(no commits yet)"
    fi
    echo
    echo "Changed files:"
    CHANGED="$(git status --short)"
    if [[ -z "$CHANGED" ]]; then
      echo "(working tree clean)"
    else
      echo "$CHANGED"
    fi
  )
fi
echo

# ---------------------------------------------------------------------------
# Script inventory
# ---------------------------------------------------------------------------

echo "Script Inventory"
echo "----------------"
SCRIPTS_DIR="$W3_FORGE_ROOT/scripts"
if [[ -d "$SCRIPTS_DIR" ]]; then
  COUNT=0
  while IFS= read -r -d '' f; do
    echo "  $(basename "$f")"
    COUNT=$((COUNT + 1))
  done < <(find "$SCRIPTS_DIR" -maxdepth 1 -type f -name '*.sh' -print0 | sort -z)
  echo "Total: $COUNT script(s)"
else
  echo "WARN:  Scripts directory not found: $SCRIPTS_DIR"
fi
echo

# ---------------------------------------------------------------------------
# Config inventory
# ---------------------------------------------------------------------------

echo "Config Inventory"
echo "----------------"
APPS_DIR="$W3_FORGE_ROOT/config/apps"
if [[ -d "$APPS_DIR" ]]; then
  COUNT=0
  while IFS= read -r -d '' f; do
    echo "  $(basename "$f")"
    COUNT=$((COUNT + 1))
  done < <(find "$APPS_DIR" -maxdepth 1 -type f -name '*.yml' -print0 | sort -z)
  echo "Total: $COUNT config(s)"
else
  echo "WARN:  App config directory not found: $APPS_DIR"
fi
echo

# ---------------------------------------------------------------------------
# Workspace health
# ---------------------------------------------------------------------------

echo "Workspace Health"
echo "----------------"
if [[ -z "${WORKSPACE:-}" ]]; then
  echo "ERROR: paths.workspaces unset in $CONFIG"
elif [[ ! -e "$WORKSPACE" ]]; then
  echo "WARN:  Workspace path does not yet exist: $WORKSPACE"
elif [[ ! -d "$WORKSPACE" ]]; then
  echo "ERROR: Workspace path exists but is not a directory: $WORKSPACE"
elif [[ ! -d "$WORKSPACE/.git" ]]; then
  echo "ERROR: Workspace exists but is not a git repo: $WORKSPACE"
else
  echo "OK:    Workspace is a valid git repo: $WORKSPACE"
  if command -v df >/dev/null 2>&1; then
    DISK="$(df -h "$WORKSPACE" 2>/dev/null | awk 'NR==2 {print $4 " free on " $6}')"
    if [[ -n "$DISK" ]]; then
      echo "Disk:  $DISK"
    fi
  fi
fi
echo

echo "Inspect complete (read-only)."
