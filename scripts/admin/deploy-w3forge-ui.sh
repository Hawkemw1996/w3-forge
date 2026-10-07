#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# deploy-w3forge-ui.sh
#
# W3 Core v0.5.25 - Non-interactive UI wrapper around the new
# scripts/deploy-w3forge-noninteractive.sh delegate.
#
# Called ONLY by the W3 Forge Admin Controls backend
# (POST /api/admin/controls/deploy-w3forge/run) after:
#   - action-lock acquisition,
#   - server-side validation,
#   - the explicit `confirmBackup` and `confirmDeploy` checkboxes,
#   - the typed phrase `DEPLOY`,
#   - the typed targetVersion (regex ^v[0-9]+\.[0-9]+\.[0-9]+$),
#   - the server-side cross-check that w3forge-${targetVersion}.tar.gz
#     equals the submitted package basename,
#   - and admission via the dedicated `runSafeDeploy()` path.
#
# This wrapper:
#   - NEVER runs without --yes (refusal exit 2).
#   - NEVER reads stdin from the caller. Closes stdin (< /dev/null) when
#     invoking the delegate so a misbehaving delegate cannot block on a TTY.
#   - NEVER accepts or constructs arbitrary filesystem paths from the UI.
#     The --package argument MUST be a basename (no `/`, no `..`, no leading
#     `-`) inside the approved /opt/w3forge-update-packages directory. The delegate
#     resolves the canonical path inside that directory only.
#   - Cross-checks the package basename against the typed --version to
#     guarantee `w3forge-${version}.tar.gz == package`.
#   - Delegates the actual deploy work to scripts/deploy-w3forge-noninteractive.sh
#     (or /opt/w3forge-scripts/deploy-w3forge-noninteractive.sh on the live host). The
#     delegate is invoked with its non-interactive flags:
#         --non-interactive
#         --package <basename>
#         --version <vX.Y.Z>
#         --yes-i-understand-this-replaces-runtime
#         --request-id <id>
#   - The EXISTING interactive scripts/deploy-w3forge.sh is NOT invoked.
#     That operator-only path remains unchanged and is the only path that
#     creates the git tag and pushes main. This UI path does NOT create
#     tags, commit, or push.
#   - Tags every log line with [request-id] and emits a
#     `===STRUCTURED-RESULT===` trailer the backend can parse.
#
# Output (structured trailer parsed by the safe action runner):
#   ===STRUCTURED-RESULT===
#   status=success|failed
#   request_id=<id>
#   package=<basename>
#   version=<vX.Y.Z>
#   pre_deploy_backup_path=<path|>
#   deployed_version=<semver|>
#   health_ok=<true|false|unknown>
#   version_endpoint_ok=<true|false|unknown>
#   duration_seconds=<n>
#   exit_code=<delegate_rc>
#   reason=<text>
#   ===END===
#
# Exit codes:
#   0   success (delegate reported success and emitted status=success)
#   1   delegate (deploy-w3forge-noninteractive.sh) reported failure
#   2   invalid arguments or missing --yes (refusal - UI input rejected)
#   3   pre-flight failure (delegate not executable, etc.)
#
# Logs to /opt/logs/w3forge/deploy/ (same category as the existing deploy).

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
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "deploy"; fi

# --- Config ----------------------------------------------------------------
DELEGATE="${W3_DEPLOY_NI_SCRIPT:-$SCRIPT_DIR/deploy-w3forge-noninteractive.sh}"
if [[ ! -x "$DELEGATE" && -x "${W3_SCRIPTS_DIR}/deploy-w3forge-noninteractive.sh" ]]; then
  DELEGATE="${W3_SCRIPTS_DIR}/deploy-w3forge-noninteractive.sh"
fi

# Basename and version validation regexes match the delegate exactly so we
# fail-fast before invoking the delegate at all. Defense-in-depth only - the
# delegate re-validates and is the source of truth.
PKG_REGEX='^w3forge-v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$'
VER_REGEX='^v[0-9]+\.[0-9]+\.[0-9]+$'

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
  deploy-w3forge-ui.sh --yes --package <basename> --version <vX.Y.Z> \
                      [--request-id <id>] [--source ui|api|cli]
  deploy-w3forge-ui.sh help

Required:
  --yes                Non-interactive acknowledgment from the calling runner.
  --package <basename> Release package BASENAME only (no path, no '..',
                       no leading '-').
                       Must match: w3forge-vX.Y.Z.tar.gz
  --version <vX.Y.Z>   Target version tag matching the version embedded in
                       the package basename.

Optional:
  --request-id <id>    Caller-supplied id propagated through logs.
  --source <s>         One of: ui, api, cli (recorded in logs only).

Notes:
  This wrapper invokes scripts/deploy-w3forge-noninteractive.sh in
  non-interactive apply mode. The delegate validates the basename and
  version, resolves the canonical package path inside the approved
  /opt/w3forge-update-packages directory ONLY, verifies the package, takes a
  MANDATORY fresh pre-deploy backup, then stops the w3forge service,
  extracts the package, runs DB migrations, syncs the runtime to
  /opt/w3forge, restarts the service, and probes /health and /version.

  This wrapper NEVER accepts arbitrary filesystem paths from the UI.
  Path components (`/`), parent-directory traversal (`..`), and leading
  dashes (`-`) are rejected here before the delegate is invoked.

  This UI path does NOT create git tags, commit, or push. The existing
  operator-only interactive scripts/deploy-w3forge.sh remains the sole
  path that produces release tags and pushes main.
EOF
}

# --- Arg parse -------------------------------------------------------------
YES=""
PACKAGE_BASENAME=""
TARGET_VERSION=""
REQUEST_ID=""
SOURCE_TAG="cli"

while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    --yes) YES="1"; shift ;;
    --package)
      [[ $# -ge 2 ]] || { emit_failure "--package requires a value"; exit 2; }
      PACKAGE_BASENAME="$2"; shift 2 ;;
    --version)
      [[ $# -ge 2 ]] || { emit_failure "--version requires a value"; exit 2; }
      TARGET_VERSION="$2"; shift 2 ;;
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

# Define emit_trailer up front so refusal-before-defaults paths can use it.
emit_trailer() {
  # Args: <status> <reason> [exit_code]
  local status="$1"
  local reason="$2"
  local rc="${3:-0}"
  echo "===STRUCTURED-RESULT==="
  echo "status=${status}"
  echo "request_id=${REQUEST_ID}"
  echo "package=${PACKAGE_BASENAME}"
  echo "version=${TARGET_VERSION}"
  echo "pre_deploy_backup_path="
  echo "deployed_version="
  echo "health_ok=unknown"
  echo "version_endpoint_ok=unknown"
  echo "duration_seconds=0"
  echo "exit_code=${rc}"
  echo "reason=${reason}"
  echo "===END==="
}

if [[ -z "$YES" ]]; then
  emit_failure "Refusing to run without --yes (non-interactive acknowledgment required)"
  emit_trailer "failed" "Refusing to run without --yes (non-interactive acknowledgment required)." 2
  exit 2
fi

case "$SOURCE_TAG" in
  ui|api|cli) ;;
  *) emit_failure "--source must be one of: ui, api, cli (got: $SOURCE_TAG)"
     emit_trailer "failed" "--source must be one of: ui, api, cli." 2
     exit 2 ;;
esac

if [[ -z "$REQUEST_ID" ]]; then
  REQUEST_ID="dw-$(date +%Y%m%d-%H%M%S)-$$"
fi

# --- Refuse arbitrary paths and bad basenames ------------------------------
if [[ -z "$PACKAGE_BASENAME" || -z "$TARGET_VERSION" ]]; then
  emit_failure "Both --package <basename> and --version <vX.Y.Z> are required"
  emit_trailer "failed" "Missing --package or --version argument." 2
  exit 2
fi

# Reject leading dash, path separators, and traversal anywhere in either
# argument. The anchored PKG_REGEX/VER_REGEX below already reject any value
# not starting with 'w3forge-v' / 'v', so a leading '-' is structurally
# impossible to pass. We restate the check so the rejection is obvious at
# audit-grep time and so any future regex relaxation cannot accidentally
# re-admit argv-injection-shaped values.
if [[ "$PACKAGE_BASENAME" == -* ]]; then
  emit_failure "Refusing leading-dash --package value: '${PACKAGE_BASENAME}'"
  emit_trailer "failed" "Leading-dash --package value rejected by UI wrapper." 2
  exit 2
fi
if [[ "$TARGET_VERSION" == -* ]]; then
  emit_failure "Refusing leading-dash --version value: '${TARGET_VERSION}'"
  emit_trailer "failed" "Leading-dash --version value rejected by UI wrapper." 2
  exit 2
fi
if [[ "$PACKAGE_BASENAME" == *"/"* || "$PACKAGE_BASENAME" == *".."* ]]; then
  emit_failure "Refusing arbitrary filesystem path. --package must be a BASENAME only (no '/', no '..')."
  emit_trailer "failed" "Arbitrary path or traversal in --package rejected by UI wrapper." 2
  exit 2
fi

# Strict regex match identical to the delegate's contract.
if [[ ! "$PACKAGE_BASENAME" =~ $PKG_REGEX ]]; then
  emit_failure "Invalid --package basename: '${PACKAGE_BASENAME}' does not match required pattern"
  emit_trailer "failed" "--package basename does not match the required w3forge-vX.Y.Z.tar.gz naming pattern." 2
  exit 2
fi
if [[ ! "$TARGET_VERSION" =~ $VER_REGEX ]]; then
  emit_failure "Invalid --version: '${TARGET_VERSION}' does not match required pattern (vX.Y.Z)"
  emit_trailer "failed" "--version does not match the required vX.Y.Z pattern." 2
  exit 2
fi

# Cross-check: package basename must embed the supplied version.
EXPECTED_BASENAME="w3forge-${TARGET_VERSION}.tar.gz"
if [[ "$PACKAGE_BASENAME" != "$EXPECTED_BASENAME" ]]; then
  emit_failure "Package basename (${PACKAGE_BASENAME}) does not match target version (${TARGET_VERSION}). Expected ${EXPECTED_BASENAME}."
  emit_trailer "failed" "Package basename does not match target version. Expected ${EXPECTED_BASENAME}." 2
  exit 2
fi

# --- Pre-flight ------------------------------------------------------------
if [[ ! -x "$DELEGATE" ]]; then
  emit_failure "Delegate script not executable: $DELEGATE"
  emit_trailer "failed" "Delegate script not executable: ${DELEGATE}" 3
  exit 3
fi

info "request-id : $REQUEST_ID"
info "source     : $SOURCE_TAG"
info "delegate   : $DELEGATE"
info "package    : $PACKAGE_BASENAME"
info "version    : $TARGET_VERSION"

# --- Delegate --------------------------------------------------------------
TMP_LOG="$(mktemp -t w3forge-deploy-ui.XXXXXX.log)"
cleanup_tmplog() { rm -f "$TMP_LOG" 2>/dev/null || true; }
trap cleanup_tmplog EXIT

START_TS=$(date +%s)
set +e
"$DELEGATE" \
  --non-interactive \
  --package "$PACKAGE_BASENAME" \
  --version "$TARGET_VERSION" \
  --yes-i-understand-this-replaces-runtime \
  --request-id "$REQUEST_ID" \
  </dev/null 2>&1 | tee "$TMP_LOG"
DELEGATE_RC=${PIPESTATUS[0]}
set -e
END_TS=$(date +%s)
DURATION=$(( END_TS - START_TS ))

# --- Parse delegate stdout for the structured trailer ----------------------
# Strip ANSI codes defensively, then pull the LAST occurrence of each marker
# so we always reflect the current run rather than a stale prior log line.
STRIPPED="$(sed -E 's/\x1b\[[0-9;]*m//g' "$TMP_LOG" 2>/dev/null || cat "$TMP_LOG")"

extract_trailer_field() {
  # Args: <field_name>
  local field="$1"
  printf '%s\n' "$STRIPPED" \
    | grep -aE "^${field}=" \
    | tail -n 1 \
    | sed -E "s/^${field}=//" \
    | tr -d '\r'
}

DEL_STATUS="$(extract_trailer_field 'status')"
DEL_PKG="$(extract_trailer_field 'package')"
DEL_VER="$(extract_trailer_field 'version')"
DEL_PRE="$(extract_trailer_field 'pre_deploy_backup_path')"
DEL_DEPLOYED="$(extract_trailer_field 'deployed_version')"
DEL_HEALTH="$(extract_trailer_field 'health_ok')"
DEL_VER_OK="$(extract_trailer_field 'version_endpoint_ok')"
DEL_DUR="$(extract_trailer_field 'duration_seconds')"
DEL_REASON="$(extract_trailer_field 'reason')"

# Fall back to safe defaults if the delegate didn't emit a trailer.
[[ -z "$DEL_PKG"     ]] && DEL_PKG="$PACKAGE_BASENAME"
[[ -z "$DEL_VER"     ]] && DEL_VER="$TARGET_VERSION"
[[ -z "$DEL_HEALTH"  ]] && DEL_HEALTH="unknown"
[[ -z "$DEL_VER_OK"  ]] && DEL_VER_OK="unknown"
[[ -z "$DEL_DUR"     ]] && DEL_DUR="$DURATION"
[[ -z "$DEL_REASON"  ]] && DEL_REASON="(no reason emitted by delegate)"

# --- Emit structured result trailer ---------------------------------------
if [[ $DELEGATE_RC -ne 0 || "$DEL_STATUS" == "failed" || -z "$DEL_STATUS" ]]; then
  warn "Delegate deploy reported failure (rc=${DELEGATE_RC}, status=${DEL_STATUS})"
  REASON_FAIL="$DEL_REASON"
  if [[ -z "$DEL_STATUS" && $DELEGATE_RC -ne 0 ]]; then
    REASON_FAIL="deploy-w3forge-noninteractive.sh exited non-zero (rc=${DELEGATE_RC}) without emitting a trailer."
  fi
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "package=${DEL_PKG}"
  echo "version=${DEL_VER}"
  echo "pre_deploy_backup_path=${DEL_PRE}"
  echo "deployed_version=${DEL_DEPLOYED}"
  echo "health_ok=${DEL_HEALTH}"
  echo "version_endpoint_ok=${DEL_VER_OK}"
  echo "duration_seconds=${DEL_DUR}"
  echo "exit_code=${DELEGATE_RC}"
  echo "reason=${REASON_FAIL}"
  echo "===END==="
  exit 1
fi

ok "deploy-w3forge-ui completed in ${DURATION}s"
echo "===STRUCTURED-RESULT==="
echo "status=success"
echo "request_id=${REQUEST_ID}"
echo "package=${DEL_PKG}"
echo "version=${DEL_VER}"
echo "pre_deploy_backup_path=${DEL_PRE}"
echo "deployed_version=${DEL_DEPLOYED}"
echo "health_ok=${DEL_HEALTH}"
echo "version_endpoint_ok=${DEL_VER_OK}"
echo "duration_seconds=${DEL_DUR}"
echo "exit_code=0"
echo "reason=${DEL_REASON}"
echo "===END==="

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
