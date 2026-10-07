#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# pipeline-rollback-w3forge-ui.sh
#
# W3 Core v0.5.38 — Release Pipeline UI wrapper: Rollback.
#
# v0.5.38 changes vs prior:
#   - --target-version is now also surfaced in the canonical v0.5.38
#     STRUCTURED-RESULT trailer via pp_emit_result with channel=installed
#     (rollback restores from the installed channel snapshot).
#   - The delegate (rollback-w3forge-stable.sh) continues to be the source
#     of truth and is called with the same --yes --confirm ROLLBACK --apply
#     contract.
#
# HIGH-risk. Thin UI wrapper around the EXISTING terminal-only
# rollback-w3forge-stable.sh delegate (introduced in v0.5.19). Delegates
# the actual rollback steps unchanged:
#   1. Read /opt/w3forge-stable/current-stable.json.
#   2. Validate the stable package archive (sha256 if available).
#   3. Take a fresh pre-rollback backup via /opt/w3forge-scripts/backup-w3forge.sh.
#   4. Stop w3forge.service, rsync the stable tree over /opt/w3forge,
#      reinstall + build, restart, probe /health and /version.
#
# Safety:
#   - Delegate REQUIRES `--yes --confirm ROLLBACK --apply` before any
#     mutation. We pass these only after our own --yes contract is met.
#   - --target-version <vX.Y.Z> is REQUIRED and is recorded in logs +
#     trailer for audit. We do NOT pass --target-version to the delegate
#     (the delegate uses the stable manifest as its source of truth).
#   - Never touches /opt/w3forge-deploy or any dev/* branch.
#
# Argv:
#   --yes --request-id <id> [--source ui|api|cli] --target-version <vX.Y.Z>
#
# Output:
#   ===STRUCTURED-RESULT===
#   status=success|failed|blocked
#   request_id=<id>
#   target_version=<vX.Y.Z>
#   delegate_exit_code=<n>
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

DELEGATE="${W3_ROLLBACK_SCRIPT:-/opt/w3forge-scripts/rollback-w3forge-stable.sh}"
if [[ ! -x "$DELEGATE" && -x "$SCRIPT_DIR/rollback-w3forge-stable.sh" ]]; then
  DELEGATE="$SCRIPT_DIR/rollback-w3forge-stable.sh"
fi

TARGET_VERSION=""
while [[ $# -gt 0 ]]; do
  if pp_consume_common_arg "$@"; then shift "$PP_CONSUMED"; continue; fi
  case "$1" in
    --target-version) [[ $# -ge 2 ]] || pp_fail "--target-version requires a value" 2
                      TARGET_VERSION="$2"; shift 2 ;;
    help|-h|--help) echo "pipeline-rollback-w3forge-ui.sh --yes --request-id <id> --target-version vX.Y.Z"; exit 0 ;;
    *) pp_fail "Unknown argument: $1" 2 ;;
  esac
done
pp_require_yes
pp_validate_tag "$TARGET_VERSION"

if [[ ! -x "$DELEGATE" ]]; then
  pp_emit_failure "rollback delegate not executable: $DELEGATE" \
    "target_version=${TARGET_VERSION}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

pp_info "request-id    : $PP_REQUEST_ID"
pp_info "source        : $PP_SOURCE_TAG"
pp_info "target version: $TARGET_VERSION"
pp_info "delegate      : $DELEGATE"

START=$(date +%s)

TMP_LOG="$(mktemp -t w3forge-rollback.XXXXXX.log)"
cleanup_log() { rm -f "$TMP_LOG" 2>/dev/null || true; }
trap cleanup_log EXIT

set +e
"$DELEGATE" --yes --confirm ROLLBACK --apply </dev/null 2>&1 | tee "$TMP_LOG"
RC=${PIPESTATUS[0]}
set -e

DURATION=$(( $(date +%s) - START ))

if [[ $RC -ne 0 ]]; then
  pp_warn "rollback delegate exited non-zero (rc=$RC)"
  pp_emit_failure "rollback-w3forge-stable.sh failed (rc=$RC)" \
    "target_version=${TARGET_VERSION}" "channel=installed" \
    "delegate_exit_code=${RC}" "duration_seconds=${DURATION}"
  PP_RES_SOURCE="$PP_SOURCE_TAG"; PP_RES_CHANNEL="installed"
  PP_RES_VERSION="$TARGET_VERSION"; PP_RES_DELEGATE="$DELEGATE"
  PP_RES_DELEGATE_EXIT_CODE="$RC"; PP_RES_DURATION_SECONDS="$DURATION"
  PP_RES_LOG_PATH="$TMP_LOG"
  declare -F pp_emit_result >/dev/null 2>&1 && pp_emit_result "failed" "delegate exited ${RC}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

pp_ok "rollback completed (${DURATION}s)"
pp_emit_success "target_version=${TARGET_VERSION}" "channel=installed" \
  "delegate_exit_code=0" "duration_seconds=${DURATION}"

# v0.5.38 canonical trailer (channel=installed because the rollback source
# is the installed-channel snapshot tracked by current-stable.json).
PP_RES_SOURCE="$PP_SOURCE_TAG"
PP_RES_CHANNEL="installed"
PP_RES_VERSION="$TARGET_VERSION"
PP_RES_DELEGATE="$DELEGATE"
PP_RES_DELEGATE_EXIT_CODE="0"
PP_RES_DURATION_SECONDS="$DURATION"
PP_RES_LOG_PATH="$TMP_LOG"
if declare -F pp_emit_result >/dev/null 2>&1; then
  pp_emit_result "success" "rollback completed via rollback-w3forge-stable.sh"
fi

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
