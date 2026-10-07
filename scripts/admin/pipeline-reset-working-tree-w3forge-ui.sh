#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-reset-working-tree-w3forge-ui.sh
#
# W3 Core v0.5.29 — Release Pipeline UI wrapper: Reset Working Tree.
#
# HIGH-risk DESTRUCTIVE local operation. Discards uncommitted changes in
# /opt/w3forge-deploy by running:
#     git reset --hard HEAD
#     git clean -fdx -e node_modules -e dist
#
# Safety:
#   - Current branch MUST match dev/vX.Y.Z; main is HARD-REFUSED.
#   - Never touches /opt/w3forge (runtime), the DB, or the service.
#   - `git clean` excludes node_modules/ and dist/ so the next test run
#     does not have to rebuild from a cold cache. (The reset path still
#     drops every other untracked file, including stray .sh, .ts, .env,
#     etc.)
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
#   was_dirty=true|false
#   uncommitted_before=<n>
#   uncommitted_after=<n>
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
    help|-h|--help) echo "pipeline-reset-working-tree-w3forge-ui.sh --yes --request-id <id>"; exit 0 ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_require_deploy_dir

BRANCH="$(pp_current_branch)"
if [[ "$BRANCH" == "main" ]]; then
  pp_emit_blocked "Refusing to reset on main." "branch=${BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi
if ! [[ "$BRANCH" =~ $PP_DEV_BRANCH_REGEX ]]; then
  pp_emit_blocked "Current branch (${BRANCH}) does not match dev/vX.Y.Z" "branch=${BRANCH}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

HEAD="$(pp_head_short)"
UC_BEFORE="$(pp_git status --porcelain | grep -c '^' || true)"
WAS_DIRTY="false"
[[ "$UC_BEFORE" -gt 0 ]] && WAS_DIRTY="true"

pp_info "request-id : $PP_REQUEST_ID"
pp_info "source     : $PP_SOURCE_TAG"
pp_info "branch     : $BRANCH @ $HEAD"
pp_info "dirty (before): $WAS_DIRTY ($UC_BEFORE files)"

START=$(date +%s)
set +e
pp_git reset --hard HEAD
RESET_RC=$?
pp_git clean -fd -e node_modules -e dist
CLEAN_RC=$?
set -e
DURATION=$(( $(date +%s) - START ))
UC_AFTER="$(pp_git status --porcelain | grep -c '^' || true)"

if [[ $RESET_RC -ne 0 || $CLEAN_RC -ne 0 ]]; then
  pp_emit_failure "git reset/clean failed (reset=$RESET_RC clean=$CLEAN_RC)" \
    "branch=${BRANCH}" "head=${HEAD}" "was_dirty=${WAS_DIRTY}" \
    "uncommitted_before=${UC_BEFORE}" "uncommitted_after=${UC_AFTER}" \
    "duration_seconds=${DURATION}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

pp_ok "working tree reset (before=${UC_BEFORE} after=${UC_AFTER}, ${DURATION}s)"
pp_emit_success "branch=${BRANCH}" "head=${HEAD}" "was_dirty=${WAS_DIRTY}" \
  "uncommitted_before=${UC_BEFORE}" "uncommitted_after=${UC_AFTER}" \
  "duration_seconds=${DURATION}"

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
