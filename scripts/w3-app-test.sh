#!/usr/bin/env bash
#
# w3-app-test.sh
#
# Safe validation and test runner for W3 Forge v0.2.0.
# Part of the v0.2.0 workflow control foundation.
#
# Usage:
#   w3-app-test.sh --app <app_id>
#
# Behavior:
#   - Runs w3-app-config-validate.sh first.
#   - Runs w3-app-branch-check.sh.
#   - Optionally runs commands declared under the `tests:` section of the
#     app config, in this future-friendly shape:
#
#         tests:
#           validate_config: true
#           commands:
#             - npm run lint
#             - npm run build
#
#   - If no tests.commands are configured, prints
#     "No app test commands configured." and exits 0.
#   - Refuses to run any command containing dangerous substrings:
#       deploy, release, tag, /opt/update-packages, rm -rf,
#       hardreset, hard-reset
#   - Prints PASS / WARN / ERROR summary.
#   - Exits nonzero on any ERROR.
#
#   Never deploys, never moves packages, never touches production data.
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

# section_list <section> <key>
#   Returns each list item under `<section>: <key>:` as one line.
#   Supports the YAML pattern:
#       tests:
#         commands:
#           - npm run lint
#           - npm run build
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
# Blocked-command guard
# ---------------------------------------------------------------------------

is_blocked_command() {
  local cmd="$1"
  local pattern
  for pattern in \
    'deploy' \
    'release' \
    'tag' \
    '/opt/update-packages' \
    'rm -rf' \
    'hardreset' \
    'hard-reset'
  do
    if [[ "$cmd" == *"$pattern"* ]]; then
      echo "$pattern"
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------

echo "W3 App Test"
echo "==========="
echo "App: $APP"
echo "Config: $CONFIG"
echo

ERRORS=0
WARNINGS=0
PASSES=0

# ---------------------------------------------------------------------------
# Step 1: config validation
# ---------------------------------------------------------------------------

echo "Step 1: Config validation"
echo "-------------------------"
if "$W3_FORGE_ROOT/scripts/w3-app-config-validate.sh" --app "$APP" >/dev/null 2>&1; then
  echo "PASS:  Config validation"
  PASSES=$((PASSES + 1))
else
  echo "ERROR: Config validation failed. Run:"
  echo "       $W3_FORGE_ROOT/scripts/w3-app-config-validate.sh --app $APP"
  ERRORS=$((ERRORS + 1))
fi
echo

# ---------------------------------------------------------------------------
# Step 2: branch check
# ---------------------------------------------------------------------------

echo "Step 2: Branch check"
echo "--------------------"
WORKSPACE="$(section_value paths workspaces)"
if [[ -z "$WORKSPACE" ]]; then
  echo "WARN:  paths.workspaces is empty; skipping branch check."
  WARNINGS=$((WARNINGS + 1))
elif [[ ! -d "$WORKSPACE/.git" ]]; then
  echo "WARN:  Workspace is not a git repo; skipping branch check: $WORKSPACE"
  WARNINGS=$((WARNINGS + 1))
else
  if "$W3_FORGE_ROOT/scripts/w3-app-branch-check.sh" --app "$APP" >/dev/null 2>&1; then
    echo "PASS:  Branch check"
    PASSES=$((PASSES + 1))
  else
    echo "ERROR: Branch check failed. Run:"
    echo "       $W3_FORGE_ROOT/scripts/w3-app-branch-check.sh --app $APP"
    ERRORS=$((ERRORS + 1))
  fi
fi
echo

# ---------------------------------------------------------------------------
# Step 3: configured test commands (optional)
# ---------------------------------------------------------------------------

echo "Step 3: App test commands"
echo "-------------------------"

# Build the list of commands; guard against missing tests section.
COMMANDS="$(section_list tests commands || true)"

if [[ -z "${COMMANDS:-}" ]]; then
  echo "No app test commands configured."
else
  if [[ -z "${WORKSPACE:-}" || ! -d "${WORKSPACE:-}/.git" ]]; then
    echo "WARN:  Skipping test commands; workspace is not a git repo."
    WARNINGS=$((WARNINGS + 1))
  else
    while IFS= read -r CMD; do
      [[ -z "$CMD" ]] && continue
      BLOCKED="$(is_blocked_command "$CMD" || true)"
      if [[ -n "$BLOCKED" ]]; then
        echo "ERROR: Blocked command (matched '$BLOCKED'): $CMD"
        ERRORS=$((ERRORS + 1))
        continue
      fi
      echo "RUN:   $CMD"
      if ( cd "$WORKSPACE" && bash -c "$CMD" ) >/dev/null 2>&1; then
        echo "PASS:  $CMD"
        PASSES=$((PASSES + 1))
      else
        echo "ERROR: Command failed: $CMD"
        ERRORS=$((ERRORS + 1))
      fi
    done <<< "$COMMANDS"
  fi
fi
echo

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo "Summary"
echo "-------"
echo "Passes:   $PASSES"
echo "Warnings: $WARNINGS"
echo "Errors:   $ERRORS"

if (( ERRORS > 0 )); then
  echo "Result: ERROR"
  exit 1
fi

if (( WARNINGS > 0 )); then
  echo "Result: WARN"
  exit 0
fi

echo "Result: PASS"
exit 0
