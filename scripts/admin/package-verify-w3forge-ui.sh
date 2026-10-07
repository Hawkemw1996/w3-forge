#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# package-verify-w3forge-ui.sh
#
# W3 Core v0.5.38 — Non-interactive UI wrapper around package-verify-w3forge.sh.
#
# v0.5.38: adds --channel/--version pass-through so the UI can ask for
# verification of a specific channel/version pair under the new canonical
# layout (/opt/w3forge-update-packages/<channel>/<version>/w3forge.tar.gz). When
# --channel/--version are provided, --package is ignored; resolution is
# delegated to package-verify-w3forge.sh. Legacy --package and the default
# "newest staged" behavior remain unchanged.
#
# The base verifier (package-verify-w3forge.sh) fails hard with
#   "FAILURE no .tar.gz packages found in /opt/w3forge-update-packages"
# when there is no staged package. That is correct CLI behavior, but it makes
# the Admin Controls "Verify Latest Package" tile look like a broken command.
#
# This wrapper distinguishes the empty-staging-directory case from a real
# verification failure, so the Controls tab can render:
#   - status=success         when verification passed
#   - status=no_package_found when /opt/w3forge-update-packages has no *.tar.gz
#   - status=failed          when verification ran and reported a failure
#
# The wrapper is read-only with respect to /opt/w3forge, the database, and the
# systemd service. It only invokes the existing verifier (which extracts to
# /tmp and cleans up on exit).
#
# Output trailer (parsed by the safe action runner):
#   ===STRUCTURED-RESULT===
#   status=success|no_package_found|failed
#   request_id=<id>
#   package=<path or empty>
#   package_version=<X.Y.Z or empty>
#   duration_seconds=<n>
#   reason=<one-line message>
#   ===END===
#
# Exit codes:
#   0  success OR no_package_found (both are clean, expected operational states)
#   1  verification failed (real failure on a package that exists)
#   2  invalid arguments
#   3  pre-flight failure (delegate missing)

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
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "package"; fi

# --- Config ----------------------------------------------------------------
UPDATE_DIR="${W3_UPDATE_DIR:-/opt/w3forge-update-packages}"
DELEGATE="${W3_VERIFY_SCRIPT:-$SCRIPT_DIR/package-verify-w3forge.sh}"
if [[ ! -x "$DELEGATE" && -x "${W3_SCRIPTS_DIR}/package-verify-w3forge.sh" ]]; then
  DELEGATE="${W3_SCRIPTS_DIR}/package-verify-w3forge.sh"
fi

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
  package-verify-w3forge-ui.sh [--request-id <id>] [--package <name>]
  package-verify-w3forge-ui.sh [--request-id <id>] --channel <dev|main|installed> --version vX.Y.Z
  package-verify-w3forge-ui.sh help

Options:
  --request-id <id>   Caller-supplied id propagated through logs.
  --package <name>    Verify a specific package by base filename inside
                      $W3_UPDATE_DIR (must end in .tar.gz). When omitted,
                      verifies the newest staged package; if no package
                      is staged, returns status=no_package_found.
  --channel <c>       (v0.5.38) Channel to resolve under (dev|main|installed).
                      Requires --version.
  --version vX.Y.Z    (v0.5.38) Version under the channel to verify.

This wrapper is read-only. It never modifies /opt/w3forge, the database, or
the systemd service. It extracts the candidate tarball to /tmp and removes
the scratch directory on exit (via the delegate verifier).
EOF
}

REQUEST_ID=""
PACKAGE_BASENAME=""
CHANNEL=""
VERSION_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    --request-id)
      [[ $# -ge 2 ]] || { emit_failure "--request-id requires a value"; exit 2; }
      REQUEST_ID="$2"; shift 2 ;;
    --package)
      [[ $# -ge 2 ]] || { emit_failure "--package requires a value"; exit 2; }
      PACKAGE_BASENAME="$2"; shift 2 ;;
    --channel)
      [[ $# -ge 2 ]] || { emit_failure "--channel requires a value"; exit 2; }
      CHANNEL="$2"; shift 2 ;;
    --version)
      [[ $# -ge 2 ]] || { emit_failure "--version requires a value"; exit 2; }
      VERSION_ARG="$2"; shift 2 ;;
    *)
      emit_failure "Unknown argument: $1"
      usage
      exit 2
      ;;
  esac
done
if [[ -n "$CHANNEL" || -n "$VERSION_ARG" ]]; then
  [[ -n "$CHANNEL"     ]] || { emit_failure "--version requires --channel"; exit 2; }
  [[ -n "$VERSION_ARG" ]] || { emit_failure "--channel requires --version"; exit 2; }
  case "$CHANNEL" in
    dev|main|installed) : ;;
    *) emit_failure "--channel must be one of dev|main|installed (got: $CHANNEL)"; exit 2 ;;
  esac
  case "$VERSION_ARG" in
    v[0-9]*.[0-9]*.[0-9]*) : ;;
    *) emit_failure "--version must look like vX.Y.Z (got: $VERSION_ARG)"; exit 2 ;;
  esac
  if [[ -n "$PACKAGE_BASENAME" ]]; then
    info "Ignoring --package (${PACKAGE_BASENAME}); --channel/--version takes precedence"
    PACKAGE_BASENAME=""
  fi
fi
if [[ -z "$REQUEST_ID" ]]; then
  REQUEST_ID="pv-$(date +%Y%m%d-%H%M%S)-$$"
fi

# --- Pre-flight ------------------------------------------------------------
if [[ ! -x "$DELEGATE" ]]; then
  emit_failure "Delegate verifier not executable: $DELEGATE"
  echo "===STRUCTURED-RESULT==="
  echo "status=failed"
  echo "request_id=${REQUEST_ID}"
  echo "package="
  echo "package_version="
  echo "duration_seconds=0"
  echo "reason=delegate verifier missing"
  echo "===END==="
  exit 3
fi

# --- Resolve target --------------------------------------------------------
TARGET=""
if [[ -n "$CHANNEL" && -n "$VERSION_ARG" ]]; then
  # v0.5.38: delegate path resolution to the base verifier via --channel/--version.
  # We pre-flight by asking the base verifier (read-only) to resolve. If it
  # can't find anything, surface no_package_found.
  info "Resolving package via channel=${CHANNEL} version=${VERSION_ARG}"
  if   [[ -f "$SCRIPT_DIR/_w3forge-pipeline-common.sh" ]]; then
    # shellcheck disable=SC1091
    . "$SCRIPT_DIR/_w3forge-pipeline-common.sh"
  elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-pipeline-common.sh" ]]; then
    # shellcheck disable=SC1091
    . "${W3_SCRIPTS_DIR}/_w3forge-pipeline-common.sh"
  fi
  if declare -F pp_resolve_package_path >/dev/null 2>&1; then
    TARGET="$(PP_UPDATE_DIR="$UPDATE_DIR" pp_resolve_package_path "$CHANNEL" "$VERSION_ARG" 2>/dev/null || true)"
  fi
  if [[ -z "$TARGET" ]]; then
    info "No package found for channel=${CHANNEL} version=${VERSION_ARG}"
    echo "===STRUCTURED-RESULT==="
    echo "status=no_package_found"
    echo "request_id=${REQUEST_ID}"
    echo "package="
    echo "package_version=${VERSION_ARG}"
    echo "channel=${CHANNEL}"
    echo "duration_seconds=0"
    echo "reason=No package found under channel=${CHANNEL} version=${VERSION_ARG}."
    echo "===END==="
    exit 0
  fi
elif [[ -n "$PACKAGE_BASENAME" ]]; then
  # Reject anything with a path separator. Must be a bare filename inside
  # $UPDATE_DIR and must end in .tar.gz.
  case "$PACKAGE_BASENAME" in
    */*|..*|*/..*) emit_failure "--package must be a bare filename, not a path"; exit 2 ;;
  esac
  case "$PACKAGE_BASENAME" in
    *.tar.gz) ;;
    *) emit_failure "--package must end in .tar.gz"; exit 2 ;;
  esac
  CANDIDATE="$UPDATE_DIR/$PACKAGE_BASENAME"
  if [[ ! -f "$CANDIDATE" ]]; then
    info "Requested package not staged: $CANDIDATE"
    echo "===STRUCTURED-RESULT==="
    echo "status=no_package_found"
    echo "request_id=${REQUEST_ID}"
    echo "package="
    echo "package_version="
    echo "duration_seconds=0"
    echo "reason=Requested package ${PACKAGE_BASENAME} is not present in ${UPDATE_DIR}."
    echo "===END==="
    exit 0
  fi
  TARGET="$CANDIDATE"
else
  if [[ ! -d "$UPDATE_DIR" ]]; then
    info "Staging directory does not exist: $UPDATE_DIR"
    echo "===STRUCTURED-RESULT==="
    echo "status=no_package_found"
    echo "request_id=${REQUEST_ID}"
    echo "package="
    echo "package_version="
    echo "duration_seconds=0"
    echo "reason=Staging directory ${UPDATE_DIR} does not exist."
    echo "===END==="
    exit 0
  fi
  # Newest .tar.gz at top level of UPDATE_DIR (mirrors deploy/verify logic).
  TARGET="$(find "$UPDATE_DIR" -maxdepth 1 -type f -name '*.tar.gz' -printf '%T@ %p\n' 2>/dev/null \
    | sort -nr | head -n 1 | cut -d' ' -f2-)"
  if [[ -z "$TARGET" ]]; then
    info "No staged release package present in $UPDATE_DIR"
    echo "===STRUCTURED-RESULT==="
    echo "status=no_package_found"
    echo "request_id=${REQUEST_ID}"
    echo "package="
    echo "package_version="
    echo "duration_seconds=0"
    echo "reason=No staged release package found in ${UPDATE_DIR}. Upload or place a w3forge-vX.Y.Z.tar.gz before verifying."
    echo "===END==="
    exit 0
  fi
fi

info "request-id : $REQUEST_ID"
info "verifying  : $TARGET"

# --- Delegate --------------------------------------------------------------
TMP_LOG="$(mktemp -t w3forge-verify-ui.XXXXXX.log)"
cleanup_tmplog() { rm -f "$TMP_LOG" 2>/dev/null || true; }
trap cleanup_tmplog EXIT

START_TS=$(date +%s)
set +e
"$DELEGATE" "$TARGET" 2>&1 | tee "$TMP_LOG"
DELEGATE_RC=${PIPESTATUS[0]}
set -e
END_TS=$(date +%s)
DURATION=$(( END_TS - START_TS ))

# Extract package version from the delegate output (informational).
PKG_VERSION="$(grep -aE 'all four version sources equal' "$TMP_LOG" \
  | tail -n 1 | sed -E 's/.*equal[[:space:]]+//; s/\x1b\[[0-9;]*m//g' | tr -d '\r ')"

if [[ $DELEGATE_RC -eq 0 ]]; then
  ok "Verification PASSED for $TARGET"
  echo "===STRUCTURED-RESULT==="
  echo "status=success"
  echo "request_id=${REQUEST_ID}"
  echo "package=${TARGET}"
  echo "package_version=${PKG_VERSION}"
  echo "channel=${CHANNEL}"
  echo "duration_seconds=${DURATION}"
  echo "reason=Package verification passed."
  echo "===END==="
  exit 0
fi

warn "Verification FAILED for $TARGET (rc=$DELEGATE_RC)"
echo "===STRUCTURED-RESULT==="
echo "status=failed"
echo "request_id=${REQUEST_ID}"
echo "package=${TARGET}"
echo "package_version=${PKG_VERSION}"
echo "channel=${CHANNEL}"
echo "duration_seconds=${DURATION}"
echo "reason=package-verify-w3forge.sh reported a verification failure (exit ${DELEGATE_RC}). See logs above."
echo "===END==="
exit 1
