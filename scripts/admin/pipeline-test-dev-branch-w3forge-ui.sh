#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-test-dev-branch-w3forge-ui.sh
#
# W3 Core v0.5.29 — Release Pipeline UI wrapper: Test Dev Branch.
#
# MEDIUM-risk. Runs the project's test + lint commands against the
# currently checked-out dev branch in /opt/w3forge-deploy. Writes
# node_modules under the deploy checkout. Never touches /opt/w3forge
# (runtime), the database, or the systemd service.
#
# Steps (sequential, fail-fast):
#   1. Verify current branch matches dev/vX.Y.Z; refuse main.
#   2. `npm ci` (or `npm install` if no lockfile) — backend and frontend.
#   3. `npm run lint` (root, ignored if absent).
#   4. `npm test` (root) with CI=1.
#
# Argv:
#   --yes --request-id <id> [--source ui|api|cli]
#
# Output:
#   ===STRUCTURED-RESULT===
#   status=success|failed|blocked
#   request_id=<id>
#   branch=<name>
#   head=<sha>
#   install_ok=true|false
#   lint_ok=true|false
#   test_ok=true|false
#   duration_seconds=<n>
#   ===END===

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if   [[ -f "$SCRIPT_DIR/_w3forge-log.sh" ]]; then . "$SCRIPT_DIR/_w3forge-log.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-log.sh" ]];  then . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"
fi
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "pipeline"; fi

if   [[ -f "$SCRIPT_DIR/_w3forge-pipeline-common.sh" ]]; then . "$SCRIPT_DIR/_w3forge-pipeline-common.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-pipeline-common.sh" ]];  then . "${W3_SCRIPTS_DIR}/_w3forge-pipeline-common.sh"
else
  echo "[FAIL] _w3forge-pipeline-common.sh not found" >&2
  exit 3
fi

while [[ $# -gt 0 ]]; do
  if pp_consume_common_arg "$@"; then shift "$PP_CONSUMED"; continue; fi
  case "$1" in
    help|-h|--help) echo "pipeline-test-dev-branch-w3forge-ui.sh --yes --request-id <id>"; exit 0 ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_require_deploy_dir

BRANCH="$(pp_current_branch)"
if [[ "$BRANCH" == "main" ]]; then
  pp_emit_blocked "Refusing to run tests on main. Only dev/vX.Y.Z branches." "branch=${BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi
if ! [[ "$BRANCH" =~ $PP_DEV_BRANCH_REGEX ]]; then
  pp_emit_blocked "Current branch (${BRANCH}) does not match dev/vX.Y.Z" "branch=${BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

HEAD="$(pp_head_short)"
pp_info "request-id : $PP_REQUEST_ID"
pp_info "source     : $PP_SOURCE_TAG"
pp_info "branch     : $BRANCH @ $HEAD"

START=$(date +%s)
INSTALL_OK="false"; LINT_OK="false"; TEST_OK="false"

run_install() {
  local dir="$1"
  [[ -f "$dir/package.json" ]] || { pp_info "no package.json in $dir; skipping install"; return 0; }
  pp_info "installing dependencies in $dir"
  if [[ -f "$dir/package-lock.json" ]]; then
    ( cd "$dir" && CI=1 timeout 600s npm ci --no-audit --no-fund </dev/null )
  else
    ( cd "$dir" && CI=1 timeout 600s npm install --no-audit --no-fund </dev/null )
  fi
}

# --- install (root + backend + frontend) ---
set +e
run_install "$PP_DEPLOY_DIR"
INSTALL_RC=$?
set -e
if [[ $INSTALL_RC -eq 0 ]]; then INSTALL_OK="true"; else
  pp_warn "install step failed (rc=$INSTALL_RC)"
  pp_emit_failure "npm install failed" "branch=${BRANCH}" "head=${HEAD}" \
    "install_ok=false" "lint_ok=false" "test_ok=false" \
    "duration_seconds=$(( $(date +%s) - START ))"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# --- lint (root; allowed to be missing) ---
if [[ -f "$PP_DEPLOY_DIR/package.json" ]] && grep -q '"lint"' "$PP_DEPLOY_DIR/package.json" 2>/dev/null; then
  set +e
  ( cd "$PP_DEPLOY_DIR" && CI=1 timeout 300s npm run lint --silent </dev/null )
  LINT_RC=$?
  set -e
  if [[ $LINT_RC -eq 0 ]]; then LINT_OK="true"; else
    pp_warn "lint failed (rc=$LINT_RC)"
    pp_emit_failure "npm run lint failed" "branch=${BRANCH}" "head=${HEAD}" \
      "install_ok=true" "lint_ok=false" "test_ok=false" \
      "duration_seconds=$(( $(date +%s) - START ))"
    if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
    exit 1
  fi
else
  pp_info "no lint script; skipping"
  LINT_OK="true"
fi

# --- test (root) ---
if [[ -f "$PP_DEPLOY_DIR/package.json" ]] && grep -q '"test"' "$PP_DEPLOY_DIR/package.json" 2>/dev/null; then
  set +e
  ( cd "$PP_DEPLOY_DIR" && CI=1 timeout 600s npm test --silent </dev/null )
  TEST_RC=$?
  set -e
  if [[ $TEST_RC -eq 0 ]]; then TEST_OK="true"; else
    pp_warn "tests failed (rc=$TEST_RC)"
    pp_emit_failure "npm test failed" "branch=${BRANCH}" "head=${HEAD}" \
      "install_ok=true" "lint_ok=true" "test_ok=false" \
      "duration_seconds=$(( $(date +%s) - START ))"
    if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
    exit 1
  fi
else
  pp_info "no test script; skipping"
  TEST_OK="true"
fi

DURATION=$(( $(date +%s) - START ))
pp_ok "test pass: install/lint/test all green (${DURATION}s)"
pp_emit_success "branch=${BRANCH}" "head=${HEAD}" \
  "install_ok=${INSTALL_OK}" "lint_ok=${LINT_OK}" "test_ok=${TEST_OK}" \
  "duration_seconds=${DURATION}"

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
