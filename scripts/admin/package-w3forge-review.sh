#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# package-w3forge-review.sh
#
# W3 Core v0.5.19 — Build a repo-shaped review package from the currently
# checked-out dev/vX.Y.Z branch.
#
# OUT-OF-SCOPE for this script (delegated to existing tooling / user only):
#   - Creating production release packages with stripped 'review' marker.
#     Those are still produced by the existing release tooling and only the
#     user places them into /opt/w3forge-update-packages/installed/.
#   - Deploying the package. Run scripts/deploy-w3forge.sh OR
#     scripts/deploy-w3forge-review.sh (proposal-only in v0.5.19) for that.
#
# Behavior:
#   - rsync the current working tree to a temp stage, excluding:
#         .git, node_modules, **/node_modules,
#         backend/dist, frontend/admin/dist, .env*
#   - Refuse to package if VERSION != package.json version.
#   - Output: <UPDATE_DIR>/w3forge-v<VERSION>-review-<TS>.tar.gz
#       (default UPDATE_DIR = /opt/w3forge-update-packages)
#   - 'review-<TS>' suffix is intentional and prevents the package from
#     being confused with an official versioned release tarball.
#   - Verify tar can list and the archive contains VERSION + package.json.
#   - Never touches /opt/w3forge runtime, /opt/w3forge-scripts, /opt/backups/w3forge, the
#     systemd service, or the database.
#
# Usage:
#   package-w3forge-review.sh [--source <repo-dir>] [--output <path>] [--update-dir <dir>]
#   package-w3forge-review.sh help
#
# Exit codes:
#   0  package created and listed successfully
#   1  tarball creation or verification failed
#   2  invalid arguments
#   3  pre-flight failure (missing tooling, missing VERSION, version mismatch)
#
# Logs to /opt/logs/w3forge/release-candidate/.
#
# This script is terminal-only and NOT wired to the Admin Controls UI in
# v0.5.19. It does NOT create tags. It does NOT modify main.

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
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "release-candidate"; fi

# --- Config ----------------------------------------------------------------
SOURCE_REPO="${W3_REVIEW_DIR:-$(pwd)}"
UPDATE_DIR="${W3_UPDATE_DIR:-/opt/w3forge-update-packages}"
OUT_PATH=""

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
info() { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}   $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*" >&2; }

usage() {
  cat <<'EOF'
Usage:
  package-w3forge-review.sh [--source <repo-dir>] [--output <path>] [--update-dir <dir>]
  package-w3forge-review.sh help

Builds a repo-shaped review tarball from the current dev/vX.Y.Z checkout.
Output filename always carries 'review-<timestamp>' so the tarball cannot
be confused with an official versioned release.

Options:
  --source     <dir>  Repo directory to package (default: current dir or $W3_REVIEW_DIR)
  --output     <path> Explicit output tarball path (overrides default name)
  --update-dir <dir>  Output directory when --output is not given
                      (default: $W3_UPDATE_DIR or /opt/w3forge-update-packages)

Excludes: .git, node_modules (all levels), backend/dist, frontend/admin/dist, .env*
Refuses to package when VERSION != package.json version.

Terminal-only. Not wired to the Admin Controls UI in v0.5.19.
EOF
}

# --- Parse args ------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    --source)
      [[ $# -ge 2 ]] || { fail "--source requires a path"; exit 2; }
      SOURCE_REPO="$2"; shift 2 ;;
    --output|-o)
      [[ $# -ge 2 ]] || { fail "$1 requires a path"; exit 2; }
      OUT_PATH="$2"; shift 2 ;;
    --update-dir)
      [[ $# -ge 2 ]] || { fail "--update-dir requires a path"; exit 2; }
      UPDATE_DIR="$2"; shift 2 ;;
    *)
      fail "Unknown argument: $1"; usage; exit 2 ;;
  esac
done

w3forge_require_repository "$SOURCE_REPO"

# --- Pre-flight ------------------------------------------------------------
command -v rsync >/dev/null 2>&1 || { fail "rsync is required"; exit 3; }
command -v tar   >/dev/null 2>&1 || { fail "tar is required";   exit 3; }
command -v node  >/dev/null 2>&1 || { fail "node is required";  exit 3; }

[[ -d "$SOURCE_REPO" ]]          || { fail "Source repo not found: $SOURCE_REPO"; exit 3; }
[[ -f "$SOURCE_REPO/VERSION" ]]  || { fail "Missing $SOURCE_REPO/VERSION";        exit 3; }
[[ -f "$SOURCE_REPO/package.json" ]] || { fail "Missing $SOURCE_REPO/package.json"; exit 3; }
[[ -d "$SOURCE_REPO/scripts" ]]  || { fail "Missing $SOURCE_REPO/scripts/";       exit 3; }
[[ -d "$SOURCE_REPO/backend" ]]  || { fail "Missing $SOURCE_REPO/backend/";       exit 3; }
[[ -d "$SOURCE_REPO/frontend" ]] || { fail "Missing $SOURCE_REPO/frontend/";      exit 3; }

VERSION="$(tr -d '[:space:]' < "$SOURCE_REPO/VERSION")"
[[ -n "$VERSION" ]] || { fail "VERSION file is empty"; exit 3; }
PKG_VERSION="$(node -p "require('$SOURCE_REPO/package.json').version" 2>/dev/null || echo '')"
[[ -n "$PKG_VERSION" ]] || { fail "Could not read package.json version"; exit 3; }
if [[ "$VERSION" != "$PKG_VERSION" ]]; then
  fail "VERSION ($VERSION) != package.json version ($PKG_VERSION). Refusing to package."
  exit 3
fi

TS="$(date +%Y-%m-%d_%H-%M-%S)"
if [[ -z "$OUT_PATH" ]]; then
  mkdir -p "$UPDATE_DIR"
  OUT_PATH="$UPDATE_DIR/w3forge-v${VERSION}-review-${TS}.tar.gz"
fi
if [[ -e "$OUT_PATH" ]]; then
  fail "Output already exists: $OUT_PATH (refusing to overwrite)"
  exit 1
fi

info "Source repo : $SOURCE_REPO"
info "VERSION     : $VERSION"
info "Output      : $OUT_PATH"

# --- Stage -----------------------------------------------------------------
STAGE_DIR="$(mktemp -d -t w3forge-review-pkg.XXXXXX)"
cleanup_stage() { rm -rf "$STAGE_DIR" 2>/dev/null || true; }
trap cleanup_stage EXIT

mkdir -p "$STAGE_DIR/w3forge"
info "rsync staging (excluding .git, node_modules, dist, .env)..."
rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'backend/node_modules' \
  --exclude 'frontend/node_modules' \
  --exclude 'frontend/admin/node_modules' \
  --exclude 'backend/dist' \
  --exclude 'frontend/admin/dist' \
  --exclude '.env' \
  --exclude '.env.*' \
  "$SOURCE_REPO/" "$STAGE_DIR/w3forge/"

# --- Build tarball ---------------------------------------------------------
info "Creating $OUT_PATH"
( cd "$STAGE_DIR" && tar -czf "$OUT_PATH" w3forge ) \
  || { fail "tar failed to create $OUT_PATH"; rm -f "$OUT_PATH"; exit 1; }
[[ -s "$OUT_PATH" ]] || { fail "Output tarball is empty: $OUT_PATH"; rm -f "$OUT_PATH"; exit 1; }
ok "Tarball created: $OUT_PATH"

# --- Verify ----------------------------------------------------------------
info "Verifying tar listing..."
if ! tar -tzf "$OUT_PATH" >/dev/null 2>&1; then
  fail "tar -t could not list $OUT_PATH; deleting partial tarball"
  rm -f "$OUT_PATH"
  exit 1
fi
# Spot-check VERSION + package.json inside the archive.
if ! tar -tzf "$OUT_PATH" | grep -q '^w3forge/VERSION$'; then
  fail "Archive is missing w3forge/VERSION; deleting partial tarball"
  rm -f "$OUT_PATH"
  exit 1
fi
if ! tar -tzf "$OUT_PATH" | grep -q '^w3forge/package.json$'; then
  fail "Archive is missing w3forge/package.json; deleting partial tarball"
  rm -f "$OUT_PATH"
  exit 1
fi
ok "Archive listing OK; w3forge/VERSION + w3forge/package.json present"

# --- Summary ---------------------------------------------------------------
SIZE_BYTES="$(stat -c%s "$OUT_PATH" 2>/dev/null || stat -f%z "$OUT_PATH" 2>/dev/null || echo unknown)"
echo ""
echo "=============================="
echo " package-w3forge-review summary"
echo "=============================="
echo " VERSION      : $VERSION"
echo " Output       : $OUT_PATH"
echo " Size (bytes) : $SIZE_BYTES"
echo " Excludes     : .git node_modules backend/dist frontend/admin/dist .env*"
echo ""

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
