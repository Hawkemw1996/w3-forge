#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-check-remote-w3forge-ui.sh
#
# W3 Core v0.5.29 — Release Pipeline UI wrapper: Check Remote.
#
# LOW-risk read-only probe. Verifies the origin remote is reachable by
# running `git ls-remote --exit-code --heads origin` against the deploy
# checkout under /opt/w3forge-deploy. Does NOT fetch refs, modify the
# working tree, or touch /opt/w3forge (runtime).
#
# Argv contract (called only by the Admin Controls safe runner):
#   --yes                          required
#   --request-id <id>              required (propagated through logs)
#   --source <ui|api|cli>          optional (recorded in the log line only)
#
# Output (structured trailer):
#   ===STRUCTURED-RESULT===
#   status=success|failed
#   request_id=<id>
#   reachable=true|false
#   head_count=<n>
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

# --- parse args ---
while [[ $# -gt 0 ]]; do
  if pp_consume_common_arg "$@"; then shift "$PP_CONSUMED"; continue; fi
  case "$1" in
    help|-h|--help)
      cat <<'EOF'
pipeline-check-remote-w3forge-ui.sh --yes --request-id <id> [--source ui|api|cli]
Read-only: probes origin reachability via `git ls-remote --heads origin`.
EOF
      exit 0
      ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_require_deploy_dir

pp_info "request-id : $PP_REQUEST_ID"
pp_info "source     : $PP_SOURCE_TAG"
pp_info "deploy-dir : $PP_DEPLOY_DIR"

START=$(date +%s)
set +e
OUT="$(GIT_TERMINAL_PROMPT=0 timeout 15s git -C "$PP_DEPLOY_DIR" ls-remote --exit-code --heads origin 2>&1)"
RC=$?
set -e
END=$(date +%s); DURATION=$(( END - START ))

if [[ $RC -ne 0 ]]; then
  pp_warn "git ls-remote failed (rc=$RC)"
  echo "$OUT" | head -50
  pp_emit_failure "git ls-remote failed: $(echo "$OUT" | tail -1)" \
    "reachable=false" "head_count=0" "duration_seconds=${DURATION}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

HEAD_COUNT=$(echo "$OUT" | grep -c '^' || true)
pp_ok "remote reachable (${HEAD_COUNT} head refs, ${DURATION}s)"
pp_emit_success "reachable=true" "head_count=${HEAD_COUNT}" "duration_seconds=${DURATION}"

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
