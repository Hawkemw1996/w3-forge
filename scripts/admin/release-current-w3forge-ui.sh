#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# release-current-w3forge-ui.sh
#
# W3 Core v0.5.14 — Non-interactive UI wrapper around release-current-w3forge.sh.
#
# Called only by the W3 Forge Admin Controls backend (POST /admin/controls/release-current/run)
# after action-lock acquisition, validation, and confirmation. NEVER interactive.
# NEVER prompts for input. NEVER touches /opt/w3forge runtime, the PostgreSQL
# database, the systemd service, or /opt/w3forge-update-packages/installed.
#
# Behavior:
#   - Accepts --request-id <id>, --source <ui|api|cli>, --yes, --output <path>
#   - --yes is REQUIRED. Refuses to run without it.
#   - Delegates the actual repackage to release-current-w3forge.sh
#     (which is already non-interactive in v0.5.13).
#   - Tags every log line with [request-id] for the safe action runner.
#   - On success: prints a structured single-line summary the backend can parse.
#   - On failure: clean non-zero exit with a clear reason. Never hangs.
#   - Refuses to run if /opt/w3forge-deploy does not exist or has no VERSION.
#
# Output (structured trailer, parsed by the safe action runner):
#   ===STRUCTURED-RESULT===
#   status=success
#   request_id=<id>
#   output_path=/opt/w3forge-update-packages/w3forge-v<VERSION>-current-<TS>.tar.gz
#   bytes=<size>
#   duration_seconds=<n>
#   verified=true|false
#   ===END===
#
# Exit codes:
#   0   success
#   1   delegate (release-current-w3forge.sh) failed
#   2   invalid arguments or missing --yes
#   3   pre-flight failure (deploy dir missing, version unreadable)
#
# Logs to /opt/logs/w3forge/release/.

set -euo pipefail

# --- Logging ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-log.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"
fi
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "release"; fi

# --- Config ----------------------------------------------------------------
DEPLOY_DIR="${W3_DEPLOY_DIR:-/opt/w3forge-deploy}"
UPDATE_DIR="${W3_UPDATE_DIR:-/opt/w3forge-update-packages}"
DELEGATE="${W3_RELEASE_CURRENT_SCRIPT:-$SCRIPT_DIR/release-current-w3forge.sh}"
if [[ ! -x "$DELEGATE" && -x "${W3_SCRIPTS_DIR}/release-current-w3forge.sh" ]]; then
  DELEGATE="${W3_SCRIPTS_DIR}/release-current-w3forge.sh"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'
info() { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*" >&2; exit "${2:-1}"; }

usage() {
  cat <<'EOF'
Usage:
  release-current-w3forge-ui.sh --yes --request-id <id> [--source ui|api|cli] [--output <path>]
  release-current-w3forge-ui.sh help

Required:
  --yes                  Non-interactive acknowledgment from the calling runner.
                         Without --yes this script refuses to run.

Optional:
  --request-id <id>      Caller-supplied id propagated through logs (defaults to a generated id).
  --source <s>           One of: ui, api, cli. Recorded in the log line only.
  --output <path>        Override output tarball path. Default: $UPDATE_DIR/w3forge-v<VERSION>-current-<TS>.tar.gz.

Notes:
  This wrapper never modifies /opt/w3forge, the database, or the systemd service.
  It only produces a tarball under /opt/w3forge-update-packages and verifies it.
EOF
}

# --- Parse args ------------------------------------------------------------
YES=""
REQUEST_ID=""
SOURCE_TAG="cli"
OUT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    --yes) YES="1"; shift ;;
    --request-id)
      [[ $# -ge 2 ]] || fail "--request-id requires a value" 2
      REQUEST_ID="$2"; shift 2 ;;
    --source)
      [[ $# -ge 2 ]] || fail "--source requires a value" 2
      SOURCE_TAG="$2"; shift 2 ;;
    --output|-o)
      [[ $# -ge 2 ]] || fail "--output requires a path" 2
      OUT_PATH="$2"; shift 2 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$YES" ]]; then
  fail "Refusing to run without --yes (non-interactive acknowledgment required)" 2
fi
if [[ -z "$REQUEST_ID" ]]; then
  REQUEST_ID="rc-$(date +%Y%m%d-%H%M%S)-$$"
fi
case "$SOURCE_TAG" in
  ui|api|cli) ;;
  *) fail "--source must be one of: ui, api, cli (got: $SOURCE_TAG)" 2 ;;
esac

# --- Pre-flight ------------------------------------------------------------
[[ -d "$DEPLOY_DIR" ]]         || fail "Deploy dir not found: $DEPLOY_DIR" 3
[[ -f "$DEPLOY_DIR/VERSION" ]] || fail "Missing $DEPLOY_DIR/VERSION" 3
VERSION_VALUE="$(tr -d '[:space:]' < "$DEPLOY_DIR/VERSION")"
[[ -n "$VERSION_VALUE" ]]      || fail "VERSION in $DEPLOY_DIR is empty" 3
[[ -x "$DELEGATE" ]]           || fail "Delegate script not executable: $DELEGATE" 3

mkdir -p "$UPDATE_DIR"

info "request-id    : $REQUEST_ID"
info "source        : $SOURCE_TAG"
info "deploy-dir    : $DEPLOY_DIR"
info "deploy-version: $VERSION_VALUE"
info "delegate      : $DELEGATE"
[[ -n "$OUT_PATH" ]] && info "output (override): $OUT_PATH" || info "output (auto)  : $UPDATE_DIR/w3forge-v${VERSION_VALUE}-current-<TS>.tar.gz"

# --- Delegate --------------------------------------------------------------
START_TS=$(date +%s)
DELEGATE_ARGS=()
if [[ -n "$OUT_PATH" ]]; then
  DELEGATE_ARGS=(-o "$OUT_PATH")
fi

# Capture delegate output so we can extract the output path even when the
# delegate uses ANSI color codes. We tee to stdout so the caller still sees
# live progress.
TMP_LOG="$(mktemp -t w3forge-release-current.XXXXXX.log)"
cleanup_tmplog() { rm -f "$TMP_LOG" 2>/dev/null || true; }
trap cleanup_tmplog EXIT

set +e
"$DELEGATE" "${DELEGATE_ARGS[@]}" 2>&1 | tee "$TMP_LOG"
DELEGATE_RC=${PIPESTATUS[0]}
set -e

END_TS=$(date +%s)
DURATION=$(( END_TS - START_TS ))

if [[ $DELEGATE_RC -ne 0 ]]; then
  warn "Delegate exited non-zero ($DELEGATE_RC)"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "exit_code=${DELEGATE_RC}"
  echo "duration_seconds=${DURATION}"
  echo "reason=release-current-w3forge.sh exited non-zero"
  echo "===END==="
  exit 1
fi

# Extract output path: prefer explicit override, otherwise parse the "Output: <path>"
# trailer that release-current-w3forge.sh prints on success.
RESULT_PATH="$OUT_PATH"
if [[ -z "$RESULT_PATH" ]]; then
  RESULT_PATH="$(grep -aE '^Output:' "$TMP_LOG" | tail -n 1 | sed -E 's/^Output:[[:space:]]+//; s/\x1b\[[0-9;]*m//g' | tr -d '\r')"
fi

if [[ -z "$RESULT_PATH" || ! -f "$RESULT_PATH" ]]; then
  warn "Could not determine output tarball path from delegate output"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "exit_code=0"
  echo "duration_seconds=${DURATION}"
  echo "reason=output tarball not located"
  echo "===END==="
  exit 1
fi

BYTES="$(stat -c%s "$RESULT_PATH" 2>/dev/null || wc -c < "$RESULT_PATH" 2>/dev/null || echo 0)"
VERIFIED="false"
if grep -aqE 'Verification PASSED' "$TMP_LOG"; then
  VERIFIED="true"
fi

ok "release-current-w3forge-ui completed in ${DURATION}s"
echo "===STRUCTURED-RESULT==="
echo "status=success"
echo "request_id=${REQUEST_ID}"
echo "output_path=${RESULT_PATH}"
echo "bytes=${BYTES}"
echo "duration_seconds=${DURATION}"
echo "verified=${VERIFIED}"
echo "===END==="

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
