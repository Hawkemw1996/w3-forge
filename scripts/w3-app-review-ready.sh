#!/usr/bin/env bash
#
# w3-app-review-ready.sh
#
# Small final-gate script for human approval readiness.
# Part of the W3 Forge v0.3.0 review layer.
#
# Usage:
#   w3-app-review-ready.sh --app <app_id> [--base <ref>]
#
# Steps:
#   1. config validation
#   2. branch check
#   3. workflow status
#   4. diff summary
#
# Final state:
#   READY_FOR_REVIEW       - workflow status READY, working tree clean,
#                            branch matches dev/vX.Y.Z
#   REVIEW_WITH_WARNINGS   - workflow status WARN, working tree dirty,
#                            or no tests configured
#   BLOCKED                - config validation failed, branch check
#                            failed, or workflow status ERROR
#
# Exit codes:
#   0 = READY_FOR_REVIEW
#   1 = REVIEW_WITH_WARNINGS
#   2 = BLOCKED
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
      exit 2
      ;;
  esac
done

if [[ -z "$APP" ]]; then
  echo "ERROR: Missing --app <app_id>"
  exit 2
fi

CONFIG="$W3_FORGE_ROOT/config/apps/${APP}.yml"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: App config not found: $CONFIG"
  exit 2
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

echo "W3 App Review Ready"
echo "==================="
echo "App: $APP"
echo "Config: $CONFIG"
echo

STATE="READY_FOR_REVIEW"

promote() {
  # READY_FOR_REVIEW -> REVIEW_WITH_WARNINGS -> BLOCKED
  local new="$1"
  case "$STATE" in
    BLOCKED) ;;
    REVIEW_WITH_WARNINGS)
      if [[ "$new" == "BLOCKED" ]]; then
        STATE="BLOCKED"
      fi
      ;;
    READY_FOR_REVIEW)
      STATE="$new"
      ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------
# Step 1: config validation
# ---------------------------------------------------------------------------

echo "Step 1: Config validation"
echo "-------------------------"
if "$W3_FORGE_ROOT/scripts/w3-app-config-validate.sh" --app "$APP" >/dev/null 2>&1; then
  echo "OK"
else
  echo "BLOCKED: config validation failed"
  promote BLOCKED
fi
echo

# ---------------------------------------------------------------------------
# Step 2: branch check
# ---------------------------------------------------------------------------

echo "Step 2: Branch check"
echo "--------------------"
WORKSPACE="$(section_value paths workspaces)"
if [[ -z "${WORKSPACE:-}" ]]; then
  echo "BLOCKED: paths.workspaces unset"
  promote BLOCKED
elif [[ ! -d "$WORKSPACE/.git" ]]; then
  echo "REVIEW_WITH_WARNINGS: workspace is not a git repo: $WORKSPACE"
  promote REVIEW_WITH_WARNINGS
else
  if "$W3_FORGE_ROOT/scripts/w3-app-branch-check.sh" --app "$APP" >/dev/null 2>&1; then
    BRANCH="$(cd "$WORKSPACE" && git branch --show-current)"
    echo "OK: branch approved: $BRANCH"
  else
    echo "BLOCKED: branch check failed"
    promote BLOCKED
  fi
fi
echo

# ---------------------------------------------------------------------------
# Step 3: workflow status
# ---------------------------------------------------------------------------

echo "Step 3: Workflow status"
echo "-----------------------"
WF_OUT="$( "$W3_FORGE_ROOT/scripts/w3-app-workflow-status.sh" --app "$APP" 2>&1 || true )"

# v0.3.1: hardened parser. Find the `Final` section explicitly, then take
# the first non-empty, non-separator line after it. Falls back to the last
# non-empty line only if the Final block can't be located. This makes the
# parser robust against future trailing output from workflow-status.
WF_FINAL="$(echo "$WF_OUT" | awk '
  /^Final$/ { capture = 1; next }
  capture {
    # Skip the "-----" separator line that follows the "Final" header.
    if ($0 ~ /^-+$/) next
    if (NF == 0) next
    print
    exit
  }
')"
if [[ -z "$WF_FINAL" ]]; then
  WF_FINAL="$(echo "$WF_OUT" | awk 'NF{last=$0} END{print last}')"
fi

case "$WF_FINAL" in
  READY)
    echo "OK: workflow status READY"
    ;;
  WARN)
    echo "REVIEW_WITH_WARNINGS: workflow status WARN"
    promote REVIEW_WITH_WARNINGS
    ;;
  ERROR)
    echo "BLOCKED: workflow status ERROR"
    promote BLOCKED
    ;;
  *)
    echo "BLOCKED: could not determine workflow status (got '$WF_FINAL')"
    promote BLOCKED
    ;;
esac
echo

# ---------------------------------------------------------------------------
# Step 4: diff summary
# ---------------------------------------------------------------------------

echo "Step 4: Diff summary"
echo "--------------------"
DIFF_ARGS=(--app "$APP")
if [[ -n "$BASE" ]]; then
  DIFF_ARGS+=(--base "$BASE")
fi

if "$W3_FORGE_ROOT/scripts/w3-app-diff-summary.sh" "${DIFF_ARGS[@]}" >/dev/null 2>&1; then
  echo "OK"
else
  # A failed diff summary does not by itself block review readiness if the
  # workspace simply has no base ref to compare. Surface as a warning.
  echo "REVIEW_WITH_WARNINGS: diff summary could not be produced"
  promote REVIEW_WITH_WARNINGS
fi
echo

# ---------------------------------------------------------------------------
# Additional review signals
# ---------------------------------------------------------------------------

echo "Step 5: Review signals"
echo "----------------------"

# Working tree cleanliness.
# v0.3.1: expected review artifacts under docs/reports/ and logs/reports/
# are filtered out before judging cleanliness, matching the workflow-status
# behavior. Generated review reports must not block review readiness.
if [[ -n "${WORKSPACE:-}" && -d "$WORKSPACE/.git" ]]; then
  DIRTY_RAW="$(cd "$WORKSPACE" && git status --short)"
  DIRTY="$(echo "$DIRTY_RAW" | awk '
    {
      path = $0
      sub(/^...[ \t]*/, "", path)
      if (path ~ /^docs\/reports\//) next
      if (path ~ /^logs\/reports\//) next
      if (NF > 0) print
    }
  ')"
  if [[ -n "$DIRTY" ]]; then
    echo "REVIEW_WITH_WARNINGS: working tree has uncommitted changes"
    promote REVIEW_WITH_WARNINGS
  else
    if [[ -n "$DIRTY_RAW" ]]; then
      echo "OK: working tree clean (ignoring expected review artifacts)"
    else
      echo "OK: working tree clean"
    fi
  fi
fi

# Tests configured.
TEST_COMMANDS="$(section_list tests commands || true)"
if [[ -z "${TEST_COMMANDS:-}" ]]; then
  echo "REVIEW_WITH_WARNINGS: no test commands configured"
  promote REVIEW_WITH_WARNINGS
else
  echo "OK: $(echo "$TEST_COMMANDS" | grep -c .) test command(s) configured"
fi

echo

# ---------------------------------------------------------------------------
# Final state
# ---------------------------------------------------------------------------

echo "Final"
echo "-----"
echo "$STATE"

case "$STATE" in
  READY_FOR_REVIEW)     exit 0 ;;
  REVIEW_WITH_WARNINGS) exit 1 ;;
  BLOCKED)              exit 2 ;;
esac
