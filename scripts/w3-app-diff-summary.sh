#!/usr/bin/env bash
#
# w3-app-diff-summary.sh
#
# Summarize Git changes for a configured app, between a base ref and HEAD.
# Part of the W3 Forge v0.3.0 review layer.
#
# Usage:
#   w3-app-diff-summary.sh --app <app_id> [--base <ref>]
#
# Behavior:
#   - Validates the app config first.
#   - Resolves the base ref. Default order:
#       1. origin/dev/v0.2.1
#       2. HEAD~1
#   - Prints app identity, workspace, current branch, base ref,
#     changed files, `git diff --stat`, and commit list between base
#     and HEAD.
#   - Read-only. Never deploys, never tags, never pushes, never edits.
#
set -euo pipefail

W3_FORGE_ROOT="${W3_FORGE_ROOT:-/opt/w3forge-deploy}"

APP=""
BASE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP="${2:-}"
      shift 2
      ;;
    --base)
      BASE="${2:-}"
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

# Validate config first.
"$W3_FORGE_ROOT/scripts/w3-app-config-validate.sh" --app "$APP" >/dev/null

# ---------------------------------------------------------------------------
# YAML helpers
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
WORKSPACE="$(section_value paths workspaces)"

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

echo "W3 App Diff Summary"
echo "==================="
echo "App: $APP"
echo "Name: ${NAME:-(unset)}"
echo "Config: $CONFIG"
echo "Workspace: ${WORKSPACE:-(unset)}"
echo

if [[ -z "${WORKSPACE:-}" ]]; then
  echo "ERROR: paths.workspaces unset in $CONFIG"
  exit 1
fi
if [[ ! -d "$WORKSPACE/.git" ]]; then
  echo "ERROR: Workspace is not a git repo: $WORKSPACE"
  exit 1
fi

cd "$WORKSPACE"

BRANCH="$(git branch --show-current)"
HEAD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo none-yet)"

echo "Branch: $BRANCH"
echo "HEAD: $HEAD_SHA"

# ---------------------------------------------------------------------------
# Resolve base ref
# ---------------------------------------------------------------------------

resolve_ref() {
  local ref="$1"
  git rev-parse --verify --quiet "$ref" >/dev/null 2>&1
}

if [[ -z "$BASE" ]]; then
  if resolve_ref "origin/dev/v0.2.1"; then
    BASE="origin/dev/v0.2.1"
  elif resolve_ref "HEAD~1"; then
    BASE="HEAD~1"
  else
    echo "ERROR: Could not resolve a default base ref (origin/dev/v0.2.1 or HEAD~1)."
    exit 1
  fi
fi

if ! resolve_ref "$BASE"; then
  echo "ERROR: Base ref not found: $BASE"
  exit 1
fi

BASE_SHA="$(git rev-parse --short "$BASE")"
echo "Base: $BASE ($BASE_SHA)"
echo

# ---------------------------------------------------------------------------
# Changed files
# ---------------------------------------------------------------------------

echo "Changed files"
echo "-------------"
CHANGED="$(git diff --name-status "$BASE"...HEAD)"
if [[ -z "$CHANGED" ]]; then
  echo "(no files changed between $BASE and HEAD)"
else
  echo "$CHANGED"
fi
echo

# ---------------------------------------------------------------------------
# Diff stat
# ---------------------------------------------------------------------------

echo "Diff stat"
echo "---------"
STAT="$(git diff --stat "$BASE"...HEAD)"
if [[ -z "$STAT" ]]; then
  echo "(no diff stat)"
else
  echo "$STAT"
fi
echo

# ---------------------------------------------------------------------------
# Commits between base and HEAD
# ---------------------------------------------------------------------------

echo "Commits ($BASE..HEAD)"
echo "---------------------"
COMMITS="$(git log --oneline "$BASE"..HEAD 2>/dev/null || true)"
if [[ -z "$COMMITS" ]]; then
  echo "(no new commits since $BASE)"
else
  echo "$COMMITS"
fi
echo

# ---------------------------------------------------------------------------
# Working tree state
# ---------------------------------------------------------------------------

echo "Working tree"
echo "------------"
DIRTY="$(git status --short)"
if [[ -z "$DIRTY" ]]; then
  echo "Clean."
else
  echo "$DIRTY"
fi
echo

echo "Diff summary complete (read-only)."
