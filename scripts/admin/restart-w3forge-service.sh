#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# restart-w3forge-service.sh
#
# W3 Core v0.5.14 — Non-interactive service restart wrapper. SHIPS ON DISK BUT
# IS NOT WIRED TO THE UI IN v0.5.14. The Admin Controls registry continues to
# mark service-restart as NEEDS_WRAPPER until the v0.5.15 safe action runner
# (action lock + audit trail + live output) lands. This file exists so that
# v0.5.15 has a vetted, source-controlled wrapper to wire against.
#
# Behavior:
#   - Refuses to run without --yes (no interactive prompts, ever).
#   - Restarts w3forge.service via systemctl (full restart, NOT reload).
#   - Polls /health and /version after restart; fails on timeout.
#   - Emits a structured result trailer for the safe action runner.
#
# Exit codes:
#   0  success (service restarted, /health and /version recovered)
#   1  systemctl restart failed
#   2  invalid arguments
#   3  pre-flight failure (systemctl missing)
#   4  /health did not recover within HEALTH_TIMEOUT_SECONDS
#   5  /version did not recover within HEALTH_TIMEOUT_SECONDS
#
# Logs to /opt/logs/w3forge/service/.

set -uo pipefail

# --- Logging ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-log.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"
fi
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "service"; fi

# --- Config ----------------------------------------------------------------
SERVICE_NAME="${W3_SERVICE_NAME:-w3forge-admin.service}"
HEALTH_URL="${W3_HEALTH_URL:-http://localhost:8765/health}"
VERSION_URL="${W3_VERSION_URL:-http://localhost:8765/version}"
HEALTH_TIMEOUT_SECONDS="${W3_HEALTH_TIMEOUT:-30}"
POLL_INTERVAL="${W3_HEALTH_POLL:-2}"

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
info() { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
emit_failure() { echo -e "${RED}[FAIL]${NC} $*" >&2; }

usage() {
  cat <<'EOF'
Usage:
  restart-w3forge-service.sh --yes [--request-id <id>] [--source ui|api|cli]
  restart-w3forge-service.sh help

Required:
  --yes              Non-interactive acknowledgment from the calling runner.

Optional:
  --request-id <id>  Caller-supplied id propagated through logs.
  --source <s>       One of: ui, api, cli (recorded in logs only).

This wrapper restarts w3forge.service via systemctl and polls /health + /version
until they recover. It is NOT WIRED TO THE UI in v0.5.14 — see release notes.
EOF
}

YES=""
REQUEST_ID=""
SOURCE_TAG="cli"

while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    --yes) YES="1"; shift ;;
    --request-id)
      [[ $# -ge 2 ]] || { emit_failure "--request-id requires a value"; exit 2; }
      REQUEST_ID="$2"; shift 2 ;;
    --source)
      [[ $# -ge 2 ]] || { emit_failure "--source requires a value"; exit 2; }
      SOURCE_TAG="$2"; shift 2 ;;
    *)
      emit_failure "Unknown argument: $1"
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$YES" ]]; then
  emit_failure "Refusing to run without --yes (non-interactive acknowledgment required)"
  exit 2
fi
case "$SOURCE_TAG" in
  ui|api|cli) ;;
  *) emit_failure "--source must be one of: ui, api, cli"; exit 2 ;;
esac
if [[ -z "$REQUEST_ID" ]]; then
  REQUEST_ID="rs-$(date +%Y%m%d-%H%M%S)-$$"
fi

command -v systemctl >/dev/null 2>&1 || { emit_failure "systemctl not found"; exit 3; }
command -v curl >/dev/null 2>&1 || { emit_failure "curl not found"; exit 3; }

info "request-id : $REQUEST_ID"
info "source     : $SOURCE_TAG"
info "service    : $SERVICE_NAME.service"

# --- Restart ---------------------------------------------------------------
START_TS=$(date +%s)
set +e
systemctl restart "$SERVICE_NAME"
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
  emit_failure "systemctl restart $SERVICE_NAME exited $RC"
  END_TS=$(date +%s)
  DURATION=$(( END_TS - START_TS ))
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "duration_seconds=${DURATION}"
  echo "reason=systemctl restart returned exit ${RC}"
  echo "===END==="
  exit 1
fi
ok "systemctl restart $SERVICE_NAME completed"

# --- Poll health -----------------------------------------------------------
poll() {
  local url="$1" label="$2"
  local elapsed=0
  while (( elapsed < HEALTH_TIMEOUT_SECONDS )); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      ok "${label} recovered after ${elapsed}s"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$(( elapsed + POLL_INTERVAL ))
  done
  return 1
}

if ! poll "$HEALTH_URL" "/health"; then
  END_TS=$(date +%s)
  DURATION=$(( END_TS - START_TS ))
  emit_failure "/health did not recover within ${HEALTH_TIMEOUT_SECONDS}s"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "duration_seconds=${DURATION}"
  echo "reason=/health did not recover within ${HEALTH_TIMEOUT_SECONDS}s after restart"
  echo "===END==="
  exit 4
fi
if ! poll "$VERSION_URL" "/version"; then
  END_TS=$(date +%s)
  DURATION=$(( END_TS - START_TS ))
  emit_failure "/version did not recover within ${HEALTH_TIMEOUT_SECONDS}s"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "duration_seconds=${DURATION}"
  echo "reason=/version did not recover within ${HEALTH_TIMEOUT_SECONDS}s after restart"
  echo "===END==="
  exit 5
fi

END_TS=$(date +%s)
DURATION=$(( END_TS - START_TS ))
ok "Service restart completed in ${DURATION}s"
echo "===STRUCTURED-RESULT==="
echo "status=success"
echo "request_id=${REQUEST_ID}"
echo "duration_seconds=${DURATION}"
echo "reason=Service restarted and /health + /version recovered."
echo "===END==="
exit 0
