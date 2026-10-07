#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# mark-w3forge-stable.sh
#
# W3 Core v0.5.19 — Record the currently running W3 Forge runtime as the
# known-good rollback point.
#
# This script writes one metadata file:
#   /opt/w3forge-stable/current-stable.json
#
# It does NOT:
#   - copy or move any package archive
#   - touch /opt/w3forge (runtime)
#   - touch /opt/w3forge-scripts (installed scripts)
#   - touch /opt/backups/w3forge
#   - modify the database
#   - restart the systemd service
#
# It does NOT decide what to roll back to — it just records what is
# currently live as the "trusted" point so rollback-w3forge-stable.sh has
# something to aim at.
#
# Usage:
#   mark-w3forge-stable.sh --yes [--reason <text>] [--metadata-dir <dir>] [--package <path>]
#   mark-w3forge-stable.sh help
#
# Required:
#   --yes                Non-interactive acknowledgement.
#
# Optional:
#   --reason <text>      Free-text reason to record (e.g. "v0.5.18 deploy
#                        passed smoke-test, mark as last known good").
#   --metadata-dir <dir> Override metadata directory (default
#                        /opt/w3forge-stable). Created if missing.
#   --package <path>     Explicit path to the package archive that produced
#                        the running runtime. If omitted, the script tries
#                        to discover the newest matching archive under
#                        /opt/w3forge-update-packages/installed/.
#
# Exit codes:
#   0  metadata written
#   1  unexpected runtime failure (e.g. cannot write metadata dir)
#   2  invalid arguments
#   3  pre-flight failure (missing tooling / missing VERSION)
#
# Terminal-only. Not wired to the Admin Controls UI in v0.5.19.
# Logs to /opt/logs/w3forge/release-candidate/.

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
APP_DIR="${W3_APP_DIR:-/opt/w3forge}"
DEPLOY_DIR="${W3_DEPLOY_DIR:-/opt/w3forge-deploy}"
METADATA_DIR_DEFAULT="${W3_STABLE_DIR:-/opt/w3forge-stable}"
INSTALLED_DIR_DEFAULT="${W3_INSTALLED_DIR:-/opt/w3forge-update-packages/installed}"
BASE_URL="${W3_BASE_URL:-http://localhost:8765}"
TIMEOUT="${W3_CURL_TIMEOUT:-5}"

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
  mark-w3forge-stable.sh --yes [--reason <text>] [--metadata-dir <dir>] [--package <path>]
  mark-w3forge-stable.sh help

Writes /opt/w3forge-stable/current-stable.json (or --metadata-dir override)
describing the currently running W3 Forge runtime as a known-good rollback
point. Does NOT copy packages, restart the service, or touch the database.

Required:
  --yes                 Non-interactive acknowledgement.

Optional:
  --reason <text>       Free-text reason to record.
  --metadata-dir <dir>  Default /opt/w3forge-stable.
  --package <path>      Explicit installed package archive path. If omitted,
                        the newest *.tar.gz under /opt/w3forge-update-packages/installed/
                        is used.

Terminal-only. Not wired to the Admin Controls UI in v0.5.19.
EOF
}

# --- Parse args ------------------------------------------------------------
YES=""
REASON=""
METADATA_DIR="$METADATA_DIR_DEFAULT"
PACKAGE_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    --yes) YES="1"; shift ;;
    --reason)
      [[ $# -ge 2 ]] || { fail "--reason requires a value"; exit 2; }
      REASON="$2"; shift 2 ;;
    --metadata-dir)
      [[ $# -ge 2 ]] || { fail "--metadata-dir requires a path"; exit 2; }
      METADATA_DIR="$2"; shift 2 ;;
    --package)
      [[ $# -ge 2 ]] || { fail "--package requires a path"; exit 2; }
      PACKAGE_PATH="$2"; shift 2 ;;
    *)
      fail "Unknown argument: $1"; usage; exit 2 ;;
  esac
done

if [[ -z "$YES" ]]; then
  fail "Refusing to run without --yes (non-interactive acknowledgement required)"
  exit 2
fi

command -v curl >/dev/null 2>&1 || warn "curl missing; live /version + /health will be marked unknown"
command -v sha256sum >/dev/null 2>&1 || warn "sha256sum missing; package_sha256 will be marked unknown"

# --- Gather runtime metadata -----------------------------------------------
RUNTIME_VERSION="<unknown>"
if [[ -f "$APP_DIR/VERSION" ]]; then
  RUNTIME_VERSION="$(tr -d '[:space:]' < "$APP_DIR/VERSION")"
fi

DEPLOY_VERSION="<unknown>"
if [[ -f "$DEPLOY_DIR/VERSION" ]]; then
  DEPLOY_VERSION="$(tr -d '[:space:]' < "$DEPLOY_DIR/VERSION")"
fi

GIT_COMMIT="<unknown>"
GIT_TAG="<unknown>"
if command -v git >/dev/null 2>&1 && [[ -d "$DEPLOY_DIR/.git" ]]; then
  GIT_COMMIT="$(git -C "$DEPLOY_DIR" rev-parse HEAD 2>/dev/null || echo '<unknown>')"
  # Show tags pointing at HEAD, comma-joined; '<none>' if none.
  TAGS_AT_HEAD="$(git -C "$DEPLOY_DIR" tag --points-at HEAD 2>/dev/null | paste -sd, - || true)"
  [[ -n "$TAGS_AT_HEAD" ]] && GIT_TAG="$TAGS_AT_HEAD" || GIT_TAG="<none>"
fi

# Resolve package path if not supplied.
#
# v0.5.38: prefer canonical layout installed/<vX.Y.Z>/w3forge.tar.gz
#          (newest by mtime among per-version subdirs), then fall back to
#          legacy flat installed/w3forge-<v>.tar.gz layout. Live mutation
#          behavior is unchanged; only discovery is broadened.
if [[ -z "$PACKAGE_PATH" ]]; then
  if [[ -d "$INSTALLED_DIR_DEFAULT" ]]; then
    # 1) Canonical: installed/<v>/w3forge.tar.gz (or .zip)
    PACKAGE_PATH="$(find "$INSTALLED_DIR_DEFAULT" -mindepth 2 -maxdepth 2 -type f \( -name 'w3forge.tar.gz' -o -name 'w3forge.zip' \) -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)"
    # 2) Legacy flat: installed/w3forge-<v>.tar.gz
    if [[ -z "$PACKAGE_PATH" ]]; then
      PACKAGE_PATH="$(find "$INSTALLED_DIR_DEFAULT" -maxdepth 1 -type f \( -name 'w3forge-*.tar.gz' -o -name 'w3forge-*.zip' \) -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)"
    fi
  fi
fi
PACKAGE_PATH="${PACKAGE_PATH:-<unknown>}"
PACKAGE_SHA256="<unknown>"
if [[ -f "$PACKAGE_PATH" ]] && command -v sha256sum >/dev/null 2>&1; then
  PACKAGE_SHA256="$(sha256sum "$PACKAGE_PATH" | awk '{print $1}')"
fi

# /health + /version
HEALTH_RESULT="<unknown>"
VERSION_RESULT="<unknown>"
if command -v curl >/dev/null 2>&1; then
  HEALTH_RESULT="$(curl -fsS --max-time "$TIMEOUT" "$BASE_URL/health" 2>/dev/null || echo '<unreachable>')"
  VERSION_RESULT="$(curl -fsS --max-time "$TIMEOUT" "$BASE_URL/version" 2>/dev/null || echo '<unreachable>')"
fi

MARKED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HOST="$(hostname 2>/dev/null || echo '<unknown>')"

# --- Write metadata --------------------------------------------------------
if ! mkdir -p "$METADATA_DIR"; then
  fail "Could not create metadata dir: $METADATA_DIR"
  exit 1
fi

OUT="$METADATA_DIR/current-stable.json"
PREV=""
if [[ -f "$OUT" ]]; then
  PREV="$METADATA_DIR/previous-stable.$(date -u +%Y%m%dT%H%M%SZ).json"
  cp "$OUT" "$PREV" || { fail "Could not preserve previous metadata as $PREV"; exit 1; }
  info "Previous stable metadata preserved at: $PREV"
fi

# JSON-encode the reason + health/version strings to keep the file valid.
json_encode() {
  python3 - "$1" <<'PY' 2>/dev/null || printf '"%s"' "${1//\"/\\\"}"
import json,sys
print(json.dumps(sys.argv[1]))
PY
}

REASON_JSON="$(json_encode "$REASON")"
HEALTH_JSON="$(json_encode "$HEALTH_RESULT")"
VERSION_JSON="$(json_encode "$VERSION_RESULT")"
PKG_JSON="$(json_encode "$PACKAGE_PATH")"
PKG_SHA_JSON="$(json_encode "$PACKAGE_SHA256")"
GIT_COMMIT_JSON="$(json_encode "$GIT_COMMIT")"
GIT_TAG_JSON="$(json_encode "$GIT_TAG")"
HOST_JSON="$(json_encode "$HOST")"
APP_DIR_JSON="$(json_encode "$APP_DIR")"
DEPLOY_DIR_JSON="$(json_encode "$DEPLOY_DIR")"
RUNTIME_V_JSON="$(json_encode "$RUNTIME_VERSION")"
DEPLOY_V_JSON="$(json_encode "$DEPLOY_VERSION")"

cat > "$OUT" <<JSON
{
  "schemaVersion": 1,
  "markedAt": "$MARKED_AT",
  "host": $HOST_JSON,
  "reason": $REASON_JSON,
  "runtime": {
    "appDir": $APP_DIR_JSON,
    "deployDir": $DEPLOY_DIR_JSON,
    "appVersion": $RUNTIME_V_JSON,
    "deployVersion": $DEPLOY_V_JSON,
    "gitCommit": $GIT_COMMIT_JSON,
    "gitTagsAtHead": $GIT_TAG_JSON
  },
  "package": {
    "path": $PKG_JSON,
    "sha256": $PKG_SHA_JSON
  },
  "live": {
    "baseUrl": "$BASE_URL",
    "health": $HEALTH_JSON,
    "version": $VERSION_JSON
  }
}
JSON

ok "Wrote: $OUT"
echo ""
echo "=============================="
echo " mark-w3forge-stable summary"
echo "=============================="
echo " markedAt        : $MARKED_AT"
echo " host            : $HOST"
echo " runtime version : $RUNTIME_VERSION"
echo " deploy version  : $DEPLOY_VERSION"
echo " git commit      : $GIT_COMMIT"
echo " git tag(s)      : $GIT_TAG"
echo " package path    : $PACKAGE_PATH"
echo " package sha256  : $PACKAGE_SHA256"
echo " /health (live)  : $HEALTH_RESULT"
echo " /version (live) : $VERSION_RESULT"
echo " metadata file   : $OUT"
[[ -n "$PREV" ]] && echo " previous file   : $PREV"
echo ""

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
