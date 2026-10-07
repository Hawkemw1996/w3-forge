#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-fetch-tags-w3forge-ui.sh
#
# W3 Core v0.5.29 — Release Pipeline UI wrapper: Fetch Tags.
#
# LOW-risk metadata-only operation. Runs `git fetch --tags --prune --force
# origin` against /opt/w3forge-deploy. Updates refs/tags only; never touches
# the working tree and never affects /opt/w3forge runtime.
#
# Argv contract:
#   --yes --request-id <id> [--source ui|api|cli]
#
# Output:
#   ===STRUCTURED-RESULT===
#   status=success|failed
#   request_id=<id>
#   before_count=<n>
#   after_count=<n>
#   added=<n>
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
    help|-h|--help) echo "pipeline-fetch-tags-w3forge-ui.sh --yes --request-id <id>"; exit 0 ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_require_deploy_dir

pp_info "request-id : $PP_REQUEST_ID"
pp_info "source     : $PP_SOURCE_TAG"

BEFORE=$(pp_git tag --list | grep -c '^' || true)
START=$(date +%s)
set +e
OUT="$(GIT_TERMINAL_PROMPT=0 timeout 30s git -C "$PP_DEPLOY_DIR" fetch --tags --prune --force origin 2>&1)"
RC=$?
set -e
END=$(date +%s); DURATION=$(( END - START ))

if [[ $RC -ne 0 ]]; then
  pp_warn "git fetch --tags failed (rc=$RC)"
  echo "$OUT" | head -50
  pp_emit_failure "git fetch --tags failed" \
    "before_count=${BEFORE}" "after_count=${BEFORE}" "added=0" "duration_seconds=${DURATION}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

AFTER=$(pp_git tag --list | grep -c '^' || true)
ADDED=$(( AFTER - BEFORE ))
[[ $ADDED -lt 0 ]] && ADDED=0
pp_ok "fetched tags (before=${BEFORE} after=${AFTER} added=${ADDED}, ${DURATION}s)"
pp_emit_success \
  "before_count=${BEFORE}" "after_count=${AFTER}" "added=${ADDED}" \
  "duration_seconds=${DURATION}"

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
