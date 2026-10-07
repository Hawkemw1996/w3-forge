#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# release-current-w3forge.sh
#
# Emergency re-packaging tool. Produces a repo-shaped .tar.gz of the
# currently-deployed /opt/w3forge-deploy Git checkout. Intended for
# forensic backup / transfer / restore-from-image planning.
#
# This is NOT a substitute for normal repo-based releases. Normal
# releases are built from the GitHub repo and dropped into
# /opt/w3forge-update-packages/ by the developer/architect, then deployed by
# /opt/w3forge-scripts/deploy-w3forge.sh per the standard process.
#
# Usage:
#   release-current-w3forge.sh
#       Write tarball to /opt/w3forge-update-packages/w3forge-v<VERSION>-current-<TS>.tar.gz
#
#   release-current-w3forge.sh -o <path>
#       Write tarball to <path>
#
#   release-current-w3forge.sh help
#
# Behavior:
#   - Reads version from $DEPLOY_DIR/VERSION (default /opt/w3forge-deploy/VERSION)
#   - rsync -a $DEPLOY_DIR/ to /tmp/w3forge-release.<pid>/w3forge/
#       excluding .git, node_modules, .env, backend/dist, frontend/admin/dist
#   - tar -czf the output
#   - Runs package-verify-w3forge.sh against the result
#   - On verify failure, deletes the partial tarball and exits non-zero
#
# Never touches /opt/w3forge runtime, the database, the service, or
# INSTALLED_DIR. Output filename always carries 'current-<timestamp>' so
# it cannot be confused with an official versioned release.
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
VERIFY_SCRIPT="${W3_VERIFY_SCRIPT:-$SCRIPT_DIR/package-verify-w3forge.sh}"
if [[ ! -x "$VERIFY_SCRIPT" && -x "${W3_SCRIPTS_DIR}/package-verify-w3forge.sh" ]]; then
  VERIFY_SCRIPT="${W3_SCRIPTS_DIR}/package-verify-w3forge.sh"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'
info() { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  release-current-w3forge.sh                Write tarball to
                                           /opt/w3forge-update-packages/w3forge-v<VERSION>-current-<TS>.tar.gz
  release-current-w3forge.sh -o <path>      Write tarball to <path>
  release-current-w3forge.sh help           Show this help

This is for emergency / forensic re-packaging of the live deployed code.
It is NOT a substitute for normal repo-based releases.
EOF
}

# --- Parse args ------------------------------------------------------------
OUT_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    -o|--output)
      [[ $# -ge 2 ]] || fail "$1 requires a path argument"
      OUT_PATH="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

# --- Pre-flight ------------------------------------------------------------
[[ -d "$DEPLOY_DIR" ]]            || fail "Deploy dir not found: $DEPLOY_DIR"
[[ -f "$DEPLOY_DIR/VERSION" ]]    || fail "Missing $DEPLOY_DIR/VERSION"
[[ -d "$DEPLOY_DIR/.git" ]]       || warn "$DEPLOY_DIR is not a git checkout (continuing anyway)"
command -v rsync >/dev/null 2>&1  || fail "rsync is required"
command -v tar   >/dev/null 2>&1  || fail "tar is required"

VERSION="$(tr -d '[:space:]' < "$DEPLOY_DIR/VERSION")"
[[ -n "$VERSION" ]] || fail "VERSION in $DEPLOY_DIR is empty"
TS="$(date +%Y-%m-%d_%H-%M-%S)"

if [[ -z "$OUT_PATH" ]]; then
  mkdir -p "$UPDATE_DIR"
  OUT_PATH="$UPDATE_DIR/w3forge-v${VERSION}-current-${TS}.tar.gz"
fi

if [[ -e "$OUT_PATH" ]]; then
  fail "Output already exists: $OUT_PATH (refusing to overwrite)"
fi

info "Deploy source : $DEPLOY_DIR"
info "VERSION       : $VERSION"
info "Output        : $OUT_PATH"

# --- Stage -----------------------------------------------------------------
STAGE_DIR="$(mktemp -d -t w3forge-release.XXXXXX)"
cleanup_stage() { rm -rf "$STAGE_DIR" 2>/dev/null || true; }
trap cleanup_stage EXIT

mkdir -p "$STAGE_DIR/w3forge"
info "rsync staging to $STAGE_DIR/w3forge/"
rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'backend/dist' \
  --exclude 'frontend/admin/dist' \
  "$DEPLOY_DIR/" "$STAGE_DIR/w3forge/"

# --- Build tarball ---------------------------------------------------------
info "Creating $OUT_PATH"
( cd "$STAGE_DIR" && tar -czf "$OUT_PATH" w3forge ) \
  || fail "tar failed to create $OUT_PATH"
[[ -s "$OUT_PATH" ]] || fail "Output tarball is empty: $OUT_PATH"

ok "Tarball created: $OUT_PATH"

# --- Verify ----------------------------------------------------------------
if [[ -x "$VERIFY_SCRIPT" ]]; then
  info "Running verify: $VERIFY_SCRIPT $OUT_PATH"
  if "$VERIFY_SCRIPT" "$OUT_PATH"; then
    ok "Verification PASSED"
  else
    warn "Verification FAILED; deleting partial tarball: $OUT_PATH"
    rm -f "$OUT_PATH"
    fail "Verification failed; tarball was deleted"
  fi
else
  warn "package-verify-w3forge.sh not found or not executable at $VERIFY_SCRIPT"
  warn "Skipping verification step (tarball is still kept)"
fi

echo ""
echo "=============================="
echo " release-current-w3forge complete"
echo "=============================="
echo "Output: $OUT_PATH"
echo ""

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
