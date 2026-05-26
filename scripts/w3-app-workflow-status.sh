#!/usr/bin/env bash
#
# w3-app-workflow-status.sh
#
# Single-pane workflow readiness summary for W3 Forge v0.2.0.
# Part of the v0.2.0 workflow control foundation.
#
# Usage:
#   w3-app-workflow-status.sh --app <app_id>
#
# Aggregates:
#   - config validation
#   - branch check
#   - git status (clean / dirty)
#   - optional local model availability (Ollama)
#   - app test script (w3-app-test.sh)
#
# Final state:
#   READY  - everything green, tests pass or no tests configured
#   WARN   - working tree dirty, no tests configured, or Ollama missing
#   ERROR  - config missing/invalid, branch check failed, blocked command
#            detected, or any configured test command failed
#
# Exit codes:
#   0 = READY
#   1 = WARN
#   2 = ERROR
#
# Output stays readable for both terminal and future Forge Admin UI use.
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
      exit 2
      ;;
  esac
done

if [[ -z "$APP" ]]; then
  echo "ERROR: Missing --app <app_id>"
  exit 2
fi

CONFIG="$W3_FORGE_ROOT/config/apps/${APP}.yml"

# ---------------------------------------------------------------------------
# YAML helpers
# ---------------------------------------------------------------------------

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

section_list() {
  local section="$1"
  local key="$2"
  awk -v section="$section" -v key="$key" '
    $0 == section ":" { in_section=1; next }
    in_section && /^[^ \t#]/ { in_section=0; in_list=0 }
    in_section {
      if (match($0, "^[ \t]+"key":[ \t]*$")) {
        in_list=1
        next
      }
      if (in_list) {
        if (match($0, "^[ \t]+-[ \t]+")) {
          line = $0
          sub("^[ \t]+-[ \t]+", "", line)
          gsub(/^["'\'']|["'\'']$/, "", line)
          print line
        } else if (match($0, "^[ \t]+[A-Za-z_]+:")) {
          in_list=0
        } else if (!match($0, "^[ \t]*$") && !match($0, "^[ \t]+-")) {
          in_list=0
        }
      }
    }
  ' "$CONFIG"
}

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

echo "W3 App Workflow Status"
echo "======================"
echo "App: $APP"
echo "Config: $CONFIG"
echo

OVERALL="READY"

set_state() {
  # Promote OVERALL only upward: READY -> WARN -> ERROR.
  local new="$1"
  case "$OVERALL" in
    ERROR) ;;
    WARN)
      if [[ "$new" == "ERROR" ]]; then
        OVERALL="ERROR"
      fi
      ;;
    READY)
      OVERALL="$new"
      ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------
# Step 1: config presence + validation
# ---------------------------------------------------------------------------

echo "Step 1: Config"
echo "--------------"
if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: App config not found: $CONFIG"
  set_state ERROR
  echo
  echo "Final: $OVERALL"
  exit 2
fi

if "$W3_FORGE_ROOT/scripts/w3-app-config-validate.sh" --app "$APP" >/dev/null 2>&1; then
  echo "OK:    Config validation"
else
  echo "ERROR: Config validation failed"
  set_state ERROR
fi
echo

# ---------------------------------------------------------------------------
# Step 2: workspace + branch
# ---------------------------------------------------------------------------

echo "Step 2: Workspace and branch"
echo "----------------------------"
WORKSPACE="$(section_value paths workspaces)"

if [[ -z "$WORKSPACE" ]]; then
  echo "ERROR: paths.workspaces unset"
  set_state ERROR
elif [[ ! -d "$WORKSPACE" ]]; then
  echo "WARN:  Workspace path does not exist: $WORKSPACE"
  set_state WARN
elif [[ ! -d "$WORKSPACE/.git" ]]; then
  echo "ERROR: Workspace exists but is not a git repo: $WORKSPACE"
  set_state ERROR
else
  echo "OK:    Workspace is a git repo: $WORKSPACE"
  if "$W3_FORGE_ROOT/scripts/w3-app-branch-check.sh" --app "$APP" >/dev/null 2>&1; then
    BRANCH="$(cd "$WORKSPACE" && git branch --show-current)"
    echo "OK:    Branch approved: $BRANCH"
  else
    echo "ERROR: Branch check failed"
    set_state ERROR
  fi

  # Git cleanliness
  DIRTY="$(cd "$WORKSPACE" && git status --short)"
  if [[ -z "$DIRTY" ]]; then
    echo "OK:    Working tree clean"
  else
    echo "WARN:  Working tree has uncommitted changes"
    set_state WARN
  fi
fi
echo

# ---------------------------------------------------------------------------
# Step 3: local model availability (optional)
# ---------------------------------------------------------------------------

echo "Step 3: Local model availability"
echo "--------------------------------"
if ! command -v ollama >/dev/null 2>&1; then
  echo "WARN:  Ollama not installed or not in PATH"
  set_state WARN
else
  MODEL_COUNT="$(ollama list 2>/dev/null | awk 'NR>1 && NF>0' | wc -l | tr -d ' ')"
  if [[ -z "$MODEL_COUNT" || "$MODEL_COUNT" -eq 0 ]]; then
    echo "WARN:  Ollama installed but no local models available"
    set_state WARN
  else
    echo "OK:    Ollama available with $MODEL_COUNT model(s)"
  fi
fi
echo

# ---------------------------------------------------------------------------
# Step 4: app tests
# ---------------------------------------------------------------------------

echo "Step 4: App tests"
echo "-----------------"
COMMANDS=""
if [[ -f "$CONFIG" ]]; then
  COMMANDS="$(section_list tests commands || true)"
fi

if [[ -z "${COMMANDS:-}" ]]; then
  echo "WARN:  No app test commands configured"
  set_state WARN
else
  if "$W3_FORGE_ROOT/scripts/w3-app-test.sh" --app "$APP" >/dev/null 2>&1; then
    echo "OK:    App tests passed"
  else
    echo "ERROR: App tests failed. Run:"
    echo "       $W3_FORGE_ROOT/scripts/w3-app-test.sh --app $APP"
    set_state ERROR
  fi
fi
echo

# ---------------------------------------------------------------------------
# Final state
# ---------------------------------------------------------------------------

echo "Final"
echo "-----"
echo "$OVERALL"

case "$OVERALL" in
  READY) exit 0 ;;
  WARN)  exit 1 ;;
  ERROR) exit 2 ;;
esac
