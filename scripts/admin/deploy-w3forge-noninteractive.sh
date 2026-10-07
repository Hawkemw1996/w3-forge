#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
w3forge_database_env
w3forge_require_runtime_layout || exit 3
#
# deploy-w3forge-noninteractive.sh
#
# W3 Core v0.5.38 - Channel/Version-aware non-interactive Deploy delegate.
#
# IMPORTANT: This script is a PARALLEL implementation. The existing
# scripts/deploy-w3forge.sh remains the operator-only interactive deploy
# path and is unchanged in semantics by v0.5.38. The operator path is the
# only path that creates a git tag and pushes main. This script does NOT
# create tags, does NOT commit, does NOT push, and is invoked by the UI
# wrappers (scripts/deploy-w3forge-ui.sh, scripts/pipeline-deploy-dev-package-w3forge-ui.sh)
# after server-side validation.
#
# v0.5.38 canonical package model:
#   /opt/w3forge-update-packages/<channel>/<vX.Y.Z>/w3forge.tar.gz
# where <channel> is one of dev, main, or installed. Legacy flat layouts
# (/opt/w3forge-update-packages/w3forge-vX.Y.Z.tar.gz) are still accepted via the
# resolver fallback in _w3forge-pipeline-common.sh.
#
# Required flags:
#   --non-interactive
#   --version <vX.Y.Z>
#   --yes-i-understand-this-replaces-runtime
#   --request-id <id>
# Optional flags:
#   --channel <dev|main|installed>   (default: dev)
#   --source  <ui|api|cli|operator>  (default: cli; recorded in logs)
#   --package <basename>             (legacy; accepted for backward compat;
#                                     must match either w3forge-vX.Y.Z.tar.gz
#                                     or w3forge.tar.gz)
#
# What this script does (mirrors the equivalent steps in deploy-w3forge.sh):
#   1. Re-validate --package basename + --version + cross-check.
#   2. Verify the package via the existing scripts/package-verify-w3forge.sh
#      delegate (read-only verifier, UNCHANGED).
#   3. Take a MANDATORY fresh pre-deploy backup via the existing
#      scripts/backup-w3forge.sh delegate (UNCHANGED).
#   4. Extract the package into a fresh tmp dir, verify embedded version,
#      and rsync into /opt/w3forge-deploy (preserving .git).
#   4b. (v0.5.38) Install dependencies (npm ci, falling back to npm install)
#       and run `npm run build` inside /opt/w3forge-deploy. The release
#       tarball is built via `git archive` and therefore contains only
#       git-tracked files; backend/dist and frontend/admin/dist are gitignored
#       (and additionally hard-rejected by package-verify-w3forge.sh
#       Check 3). The runtime artifacts MUST be produced locally at
#       deploy time before the rsync to /opt/w3forge. This mirrors
#       deploy-w3forge.sh lines 556-558 (install_dependencies + npm run
#       build) verbatim and is what closes the pre-fix gap where
#       /opt/w3forge/backend/dist/index.js was missing after deploy.
#   5. Stop the w3forge systemd service.
#   6. Run database migrations from database/migrations/*.sql using the
#      same psql command line as the interactive deploy.
#   7. Verify required schema columns are present (matches deploy-w3forge.sh).
#   8. rsync the runtime to /opt/w3forge (same excludes as deploy-w3forge.sh).
#   9. Update APP_VERSION in /opt/w3forge/.env.
#  10. Restart the w3forge service.
#  11. Probe /health and /version (bounded retries).
#  12. Emit a `===STRUCTURED-RESULT===` trailer for the UI wrapper.
#
# What this script does NOT do (operator-only, restricted territory):
#   - Does NOT create git tags.
#   - Does NOT git commit.
#   - Does NOT git push.
#   - Does NOT move the package into /opt/w3forge-update-packages/installed/.
#     The installed-package archive step remains an operator action.
#   - Does NOT run a post-deploy backup.
#   - Does NOT install new server scripts (install-server-scripts.sh).
#     Server-script installation remains an operator action and is
#     decoupled from UI deploys for v0.5.25.
#
# Logs to /opt/logs/w3forge/deploy/.

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

# v0.5.38: shared resolver + structured-result helpers.
if   [[ -f "$SCRIPT_DIR/_w3forge-pipeline-common.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-pipeline-common.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-pipeline-common.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-pipeline-common.sh"
fi

# v0.12.11: shared migration ledger helper. Provides
# w3ledger_ensure_table / w3ledger_bootstrap_baseline / w3ledger_apply_migrations.
if   [[ -f "$SCRIPT_DIR/_w3forge-migration-ledger.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-migration-ledger.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-migration-ledger.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-migration-ledger.sh"
else
  echo "missing required helper: _w3forge-migration-ledger.sh" >&2
  exit 1
fi

# --- Config (mirrors deploy-w3forge.sh) -------------------------------------
APP_DIR="${W3_APP_DIR:-/opt/w3forge}"
DEPLOY_DIR="${W3_DEPLOY_DIR:-/opt/w3forge-deploy}"
SCRIPTS_DIR="${W3_SCRIPTS_DIR:-/opt/w3forge-scripts}"
UPDATE_DIR="${W3_UPDATE_DIR:-/opt/w3forge-update-packages}"
SERVICE_NAME="${W3_SERVICE_NAME:-w3forge-admin.service}"
HEALTH_URL="${W3_HEALTH_URL:-http://127.0.0.1:8765/health}"
VERSION_URL="${W3_VERSION_URL:-http://127.0.0.1:8765/version}"
DB_HOST="$W3_DB_HOST"
DB_USER="$W3_DB_USER"
DB_NAME="$W3_DB_NAME"

PKG_REGEX='^w3forge-v[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$'
CANONICAL_PKG_NAME='w3forge.tar.gz'
VER_REGEX='^v[0-9]+\.[0-9]+\.[0-9]+$'

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
emit_failure() { echo -e "${RED}[FAIL]${NC} $*" >&2; }

# --- State -----------------------------------------------------------------
NON_INTERACTIVE=""
PACKAGE_BASENAME=""
TARGET_VERSION=""
CHANNEL="dev"            # v0.5.38: default channel
SOURCE_TAG="cli"         # v0.5.38: --source recorded in trailer
YES_REPLACE=""
REQUEST_ID=""
START_TS=0
PRE_BACKUP_PATH=""
DEPLOYED_VERSION=""
HEALTH_OK="unknown"
VERSION_ENDPOINT_OK="unknown"
TMP_DIR=""
PACKAGE_PATH=""          # v0.5.38: resolved canonical or legacy path
INSTALLED_DIR_OUT=""     # v0.5.38: installed/<vX.Y.Z>/ written on success

cleanup_tmp() {
  if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup_tmp EXIT

emit_trailer() {
  # v0.5.38: emits BOTH the legacy trailer (for any existing UI parsers)
  # AND the canonical v0.5.38 trailer via pp_emit_result. The legacy
  # block is emitted first inside its own ===STRUCTURED-RESULT===
  # framing; the canonical block follows in its own framing. Parsers
  # that look for the new keys (source, channel, package_path,
  # verification, etc.) read the canonical block; legacy parsers
  # continue to find the original keys in the legacy block.
  local status="$1"
  local reason="$2"
  local rc="${3:-0}"
  local now duration
  now=$(date +%s)
  duration=$(( now - START_TS ))
  # --- Legacy trailer (unchanged shape) ---
  echo "===STRUCTURED-RESULT==="
  echo "status=${status}"
  echo "request_id=${REQUEST_ID}"
  echo "package=${PACKAGE_BASENAME}"
  echo "version=${TARGET_VERSION}"
  echo "pre_deploy_backup_path=${PRE_BACKUP_PATH}"
  echo "deployed_version=${DEPLOYED_VERSION}"
  echo "health_ok=${HEALTH_OK}"
  echo "version_endpoint_ok=${VERSION_ENDPOINT_OK}"
  echo "duration_seconds=${duration}"
  echo "exit_code=${rc}"
  echo "reason=${reason}"
  echo "===END==="
  # --- Canonical v0.5.38 trailer ---
  if declare -F pp_emit_result >/dev/null 2>&1; then
    PP_REQUEST_ID="$REQUEST_ID"
    PP_RES_SOURCE="$SOURCE_TAG"
    PP_RES_CHANNEL="$CHANNEL"
    PP_RES_VERSION="$TARGET_VERSION"
    PP_RES_PACKAGE_PATH="$PACKAGE_PATH"
    PP_RES_DELEGATE="$SCRIPT_DIR/deploy-w3forge-noninteractive.sh"
    PP_RES_DELEGATE_EXIT_CODE="$rc"
    PP_RES_DURATION_SECONDS="$duration"
    PP_RES_LOG_PATH="${W3LOG_PATH:-}"
    pp_emit_result "$status" "$reason" \
      "pre_deploy_backup_path=${PRE_BACKUP_PATH}" \
      "deployed_version=${DEPLOYED_VERSION}" \
      "health_ok=${HEALTH_OK}" \
      "version_endpoint_ok=${VERSION_ENDPOINT_OK}" \
      "installed_dir=${INSTALLED_DIR_OUT}"
  fi
}

die() {
  # Args: <reason> [exit_code]
  local reason="$1"
  local rc="${2:-1}"
  emit_failure "$reason"
  emit_trailer "failed" "$reason" "$rc"
  exit "$rc"
}

usage() {
  cat <<'EOF'
Usage:
  deploy-w3forge-noninteractive.sh \
    --non-interactive \
    --version <vX.Y.Z> \
    --yes-i-understand-this-replaces-runtime \
    [--channel dev|main|installed] \
    [--source ui|api|cli|operator] \
    [--package <basename>] \
    --request-id <id>

v0.5.38 canonical package layout:
  /opt/w3forge-update-packages/<channel>/<vX.Y.Z>/w3forge.tar.gz
Legacy flat layout is still accepted as a resolver fallback.

This is the non-interactive UI / pipeline deploy delegate. Refuses to
run without --non-interactive and --yes-i-understand-this-replaces-runtime.

The existing scripts/deploy-w3forge.sh interactive operator path is
UNCHANGED. This script does NOT create git tags, does NOT commit, and
does NOT push.
EOF
}

# --- Arg parse -------------------------------------------------------------
START_TS=$(date +%s)

while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    --non-interactive) NON_INTERACTIVE="1"; shift ;;
    --package)
      [[ $# -ge 2 ]] || die "--package requires a value" 2
      PACKAGE_BASENAME="$2"; shift 2 ;;
    --version)
      [[ $# -ge 2 ]] || die "--version requires a value" 2
      TARGET_VERSION="$2"; shift 2 ;;
    --channel)
      [[ $# -ge 2 ]] || die "--channel requires a value" 2
      CHANNEL="$2"; shift 2 ;;
    --source)
      [[ $# -ge 2 ]] || die "--source requires a value" 2
      SOURCE_TAG="$2"; shift 2 ;;
    --yes-i-understand-this-replaces-runtime)
      YES_REPLACE="1"; shift ;;
    --request-id)
      [[ $# -ge 2 ]] || die "--request-id requires a value" 2
      REQUEST_ID="$2"; shift 2 ;;
    *)
      die "Unknown argument: $1" 2
      ;;
  esac
done

# v0.5.38: validate --channel and --source.
case "$CHANNEL" in
  dev|main|installed) ;;
  *) die "--channel must be one of: dev, main, installed (got: ${CHANNEL})" 2 ;;
esac
case "$SOURCE_TAG" in
  ui|api|cli|operator) ;;
  *) die "--source must be one of: ui, api, cli, operator (got: ${SOURCE_TAG})" 2 ;;
esac

if [[ -z "$NON_INTERACTIVE" ]]; then
  die "Refusing to run without --non-interactive (operator-only mode disabled in this delegate)." 2
fi
if [[ -z "$YES_REPLACE" ]]; then
  die "Refusing to run without --yes-i-understand-this-replaces-runtime acknowledgment." 2
fi
if [[ -z "$REQUEST_ID" ]]; then
  REQUEST_ID="dw-$(date +%Y%m%d-%H%M%S)-$$"
fi

# --- Re-validate inputs (defence in depth) ---------------------------------
if [[ -z "$TARGET_VERSION" ]]; then
  die "--version is required." 2
fi
if [[ "$TARGET_VERSION" == -* ]]; then
  die "Leading-dash --version value rejected: ${TARGET_VERSION}" 2
fi
if [[ ! "$TARGET_VERSION" =~ $VER_REGEX ]]; then
  die "--version does not match vX.Y.Z: ${TARGET_VERSION}" 2
fi

# --package is optional in v0.5.38 (the channel+version path is the source
# of truth). When supplied it must be either the legacy versioned name
# matching --version or the new canonical name 'w3forge.tar.gz'.
if [[ -n "$PACKAGE_BASENAME" ]]; then
  if [[ "$PACKAGE_BASENAME" == -* ]]; then
    die "Leading-dash --package value rejected: ${PACKAGE_BASENAME}" 2
  fi
  if [[ "$PACKAGE_BASENAME" == *"/"* || "$PACKAGE_BASENAME" == *".."* ]]; then
    die "Arbitrary path or traversal in --package rejected: ${PACKAGE_BASENAME}" 2
  fi
  if [[ "$PACKAGE_BASENAME" != "$CANONICAL_PKG_NAME" ]]; then
    if [[ ! "$PACKAGE_BASENAME" =~ $PKG_REGEX ]]; then
      die "--package basename does not match w3forge-vX.Y.Z.tar.gz or ${CANONICAL_PKG_NAME}: ${PACKAGE_BASENAME}" 2
    fi
    EXPECTED_LEGACY_BASENAME="w3forge-${TARGET_VERSION}.tar.gz"
    if [[ "$PACKAGE_BASENAME" != "$EXPECTED_LEGACY_BASENAME" ]]; then
      die "Package basename (${PACKAGE_BASENAME}) does not match target version (${TARGET_VERSION}). Expected ${EXPECTED_LEGACY_BASENAME} or ${CANONICAL_PKG_NAME}." 2
    fi
  fi
fi

# --- Resolve canonical package path with legacy fallback ------------------
# Lookup order (from _w3forge-pipeline-common.sh::pp_resolve_package_path):
#   1. ${UPDATE_DIR}/<channel>/<vX.Y.Z>/w3forge.tar.gz
#   2. ${UPDATE_DIR}/<channel>/w3forge-<vX.Y.Z>.tar.gz
#   3. ${UPDATE_DIR}/w3forge-<vX.Y.Z>.tar.gz  (only for non-installed)
W3_UPDATE_DIR="$UPDATE_DIR" \
  PACKAGE_PATH="$(PP_UPDATE_DIR="$UPDATE_DIR" pp_resolve_package_path "$CHANNEL" "$TARGET_VERSION" 2>/dev/null || true)"
if [[ -z "$PACKAGE_PATH" || ! -f "$PACKAGE_PATH" ]]; then
  die "Package not found for channel=${CHANNEL} version=${TARGET_VERSION}. Looked under ${UPDATE_DIR}/${CHANNEL}/${TARGET_VERSION}/${CANONICAL_PKG_NAME} and legacy fallbacks." 2
fi
# Defence-in-depth: realpath the file and confirm it lives under UPDATE_DIR
# (not just the legacy flat root). This rejects symlinks that escape.
REAL_PKG="$(readlink -f "$PACKAGE_PATH" 2>/dev/null || echo "$PACKAGE_PATH")"
REAL_UPDATE_DIR="$(readlink -f "$UPDATE_DIR" 2>/dev/null || echo "$UPDATE_DIR")"
case "$REAL_PKG" in
  "$REAL_UPDATE_DIR"/*) : ;;
  *) die "Resolved package path escapes the approved directory: ${REAL_PKG}" 2 ;;
esac

# Recompute the effective basename now that we may have resolved the
# canonical (w3forge.tar.gz) or legacy (w3forge-<v>.tar.gz) name.
PACKAGE_BASENAME="$(basename "$PACKAGE_PATH")"

info "request-id : $REQUEST_ID"
info "channel    : $CHANNEL"
info "source     : $SOURCE_TAG"
info "version    : $TARGET_VERSION"
info "package    : $PACKAGE_BASENAME"
info "path       : $PACKAGE_PATH"

# --- Pre-flight: required runtime layout ----------------------------------
[[ -d "$DEPLOY_DIR" ]] || die "Deploy checkout missing: ${DEPLOY_DIR}" 3
[[ -d "$DEPLOY_DIR/.git" ]] || die "${DEPLOY_DIR} is not a git checkout" 3
[[ -d "$APP_DIR" ]] || die "Runtime dir missing: ${APP_DIR}" 3

# --- 2) Verify package via existing read-only verifier --------------------
VERIFY_DELEGATE="$SCRIPT_DIR/package-verify-w3forge.sh"
if [[ ! -x "$VERIFY_DELEGATE" && -x "${W3_SCRIPTS_DIR}/package-verify-w3forge.sh" ]]; then
  VERIFY_DELEGATE="${W3_SCRIPTS_DIR}/package-verify-w3forge.sh"
fi
if [[ ! -x "$VERIFY_DELEGATE" ]]; then
  die "package-verify-w3forge.sh not executable: ${VERIFY_DELEGATE}" 3
fi
info "Verifying package via $VERIFY_DELEGATE"
if ! "$VERIFY_DELEGATE" "$PACKAGE_PATH" </dev/null; then
  die "Package verification failed for ${PACKAGE_BASENAME}." 1
fi
ok "Package verified"

# --- 3) Mandatory pre-deploy backup via unmodified backup delegate --------
BACKUP_DELEGATE="$SCRIPT_DIR/backup-w3forge.sh"
if [[ ! -x "$BACKUP_DELEGATE" && -x "${W3_SCRIPTS_DIR}/backup-w3forge.sh" ]]; then
  BACKUP_DELEGATE="${W3_SCRIPTS_DIR}/backup-w3forge.sh"
fi
if [[ ! -x "$BACKUP_DELEGATE" ]]; then
  die "backup-w3forge.sh not executable: ${BACKUP_DELEGATE}" 3
fi
info "Running mandatory pre-deploy backup via $BACKUP_DELEGATE"
BACKUP_OUT="$(mktemp -t w3forge-deploy-backup.XXXXXX.log)"
if ! "$BACKUP_DELEGATE" </dev/null >"$BACKUP_OUT" 2>&1; then
  cat "$BACKUP_OUT" >&2 || true
  rm -f "$BACKUP_OUT"
  die "Pre-deploy backup failed." 1
fi
# Extract the produced app backup path for the trailer (best-effort).
PRE_BACKUP_PATH="$(grep -aoE '/opt/backups/w3forge/w3forge_app_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.tar\.gz' "$BACKUP_OUT" | tail -n 1 || true)"
cat "$BACKUP_OUT"
rm -f "$BACKUP_OUT"
ok "Pre-deploy backup complete: ${PRE_BACKUP_PATH:-(path not parsed)}"

# --- 4) Extract package, verify embedded version, import into DEPLOY_DIR --
TMP_DIR="$(mktemp -d /tmp/w3forge-deploy-ni.XXXXXX)"
info "Extracting package to $TMP_DIR"
w3forge_verify_archive "$PACKAGE_PATH" || exit 3
if ! tar -xzf "$PACKAGE_PATH" -C "$TMP_DIR"; then
  die "Failed to extract package: ${PACKAGE_PATH}" 1
fi

# Resolve repo root (matches deploy-w3forge.sh logic).
PACKAGE_ROOT=""
if [[ -d "$TMP_DIR/w3forge" ]]; then
  PACKAGE_ROOT="$TMP_DIR/w3forge"
elif [[ -f "$TMP_DIR/VERSION" && -f "$TMP_DIR/package.json" ]]; then
  PACKAGE_ROOT="$TMP_DIR"
else
  CANDIDATE="$(find "$TMP_DIR" -mindepth 1 -maxdepth 2 -type f -name VERSION 2>/dev/null | head -n 1 | xargs -r dirname)"
  [[ -n "$CANDIDATE" ]] || die "Could not detect extracted repo root under ${TMP_DIR}" 1
  PACKAGE_ROOT="$CANDIDATE"
fi

for required in VERSION package.json backend frontend database scripts; do
  [[ -e "$PACKAGE_ROOT/$required" ]] || die "Package missing required entry: ${required}" 1
done

PACKAGE_VERSION_RAW="$(tr -d '[:space:]' < "$PACKAGE_ROOT/VERSION")"
[[ -n "$PACKAGE_VERSION_RAW" ]] || die "Package VERSION file is empty." 1
PACKAGE_VERSION_TAG="v${PACKAGE_VERSION_RAW#v}"
if [[ "$PACKAGE_VERSION_TAG" != "$TARGET_VERSION" ]]; then
  die "Package embedded version (${PACKAGE_VERSION_TAG}) does not match --version (${TARGET_VERSION})." 1
fi
ok "Package embedded VERSION matches --version (${TARGET_VERSION})"

# Cross-check all package.json files match too (same as deploy-w3forge.sh).
read_json_version() {
  python3 - "$1" <<'PY'
import json, sys
with open(sys.argv[1],'r') as f:
    print(json.load(f).get('version','').strip())
PY
}
EXPECTED_NO_V="${TARGET_VERSION#v}"
for jf in "$PACKAGE_ROOT/package.json" "$PACKAGE_ROOT/backend/package.json" "$PACKAGE_ROOT/frontend/admin/package.json"; do
  [[ -f "$jf" ]] || die "Missing $jf in package." 1
  v="$(read_json_version "$jf")"
  [[ "$v" == "$EXPECTED_NO_V" ]] || die "Version mismatch in ${jf}: expected ${EXPECTED_NO_V}, found ${v}." 1
done
ok "All package.json versions match ${EXPECTED_NO_V}"

# Sync into DEPLOY_DIR while preserving .git (matches deploy-w3forge.sh).
info "Syncing extracted package into ${DEPLOY_DIR} (preserving .git)"
if ! rsync -a --delete --exclude '.git' "$PACKAGE_ROOT/" "$DEPLOY_DIR/"; then
  die "Failed to rsync package into ${DEPLOY_DIR}." 1
fi
chown -R root:root "$DEPLOY_DIR" 2>/dev/null || true
chmod +x "$DEPLOY_DIR/scripts"/*.sh 2>/dev/null || true
if ! bash -n "$DEPLOY_DIR/scripts"/*.sh; then
  die "Syntax check failed on scripts/*.sh inside extracted package." 1
fi
ok "Package imported into ${DEPLOY_DIR}"

# --- 4b) Install dependencies + build (v0.5.38 packaging-regression fix) --
#
# The release tarball is produced by `git archive` (see
# scripts/pipeline-package-dev-release-w3forge-ui.sh) and therefore only
# contains git-tracked files. backend/dist/ and frontend/admin/dist/ are
# gitignored (and additionally rejected by package-verify-w3forge.sh
# Check 3, which treats their presence in the tarball as a structural
# error). The runtime artifacts MUST be built locally after extraction
# and BEFORE the runtime rsync to /opt/w3forge, otherwise w3forge.service
# fails to start with `Cannot find module '/opt/w3forge/backend/dist/index.js'`.
#
# This block mirrors deploy-w3forge.sh lines 325-333 (install_dependencies)
# and 556-558 (install_dependencies + npm run build), preserving the
# `npm ci` -> `npm install` fallback. Running before service stop means
# a build failure does not leave the runtime in a broken half-replaced
# state -- the previous deploy continues running until the build succeeds.
#
# DETERMINISTIC LOGGING: every step records pwd, the exact command being
# run, its exit code, and a recursive ls of backend/dist before/after the
# tsc invocation. Output goes to the systemd-run StandardOutput/Error
# log (/var/log/w3forge/deploy-${REQUEST_ID}.log on prod). When the next
# deploy fails, the operator can grep the log for `[4b]` and see exactly
# where backend/dist disappears.
info "[4b] Install + build phase starting"
info "[4b] DEPLOY_DIR        : ${DEPLOY_DIR}"
info "[4b] wrapper-cwd       : $(pwd)"
info "[4b] node              : $(command -v node || echo MISSING) ($(node --version 2>/dev/null || echo n/a))"
info "[4b] npm               : $(command -v npm  || echo MISSING) ($(npm  --version 2>/dev/null || echo n/a))"
info "[4b] pre-build  ls -lAh ${DEPLOY_DIR}"
ls -lAh "$DEPLOY_DIR" 2>&1 | sed 's/^/[4b]   /' || true
info "[4b] pre-build  ls -lAh ${DEPLOY_DIR}/backend"
ls -lAh "$DEPLOY_DIR/backend" 2>&1 | sed 's/^/[4b]   /' || true
info "[4b] pre-build  ls -lAh ${DEPLOY_DIR}/backend/dist (expected: missing)"
ls -lAh "$DEPLOY_DIR/backend/dist" 2>&1 | sed 's/^/[4b]   /' || true

set +e
(
  cd "$DEPLOY_DIR" || exit 90
  echo "[4b]   subshell-cwd : $(pwd)"
  if [[ -f package-lock.json ]]; then
    echo "[4b]   running: npm ci"
    npm ci 2>&1 | sed 's/^/[4b][npm ci] /'
    exit "${PIPESTATUS[0]}"
  else
    echo "[4b]   running: npm install"
    npm install 2>&1 | sed 's/^/[4b][npm install] /'
    exit "${PIPESTATUS[0]}"
  fi
)
INSTALL_RC=$?
set -e
info "[4b] install exit-code: ${INSTALL_RC}"
if [[ $INSTALL_RC -ne 0 ]]; then
  die "[4b] Dependency install failed (rc=${INSTALL_RC}) in ${DEPLOY_DIR}. Service NOT stopped; previous runtime still active." 1
fi

info "[4b] post-install ls -lAh ${DEPLOY_DIR}/node_modules (top 5):"
ls -lAh "$DEPLOY_DIR/node_modules" 2>&1 | head -7 | sed 's/^/[4b]   /' || true
info "[4b] post-install ls -lAh ${DEPLOY_DIR}/backend/node_modules (top 5):"
ls -lAh "$DEPLOY_DIR/backend/node_modules" 2>&1 | head -7 | sed 's/^/[4b]   /' || true

set +e
(
  cd "$DEPLOY_DIR" || exit 91
  echo "[4b]   subshell-cwd : $(pwd)"
  echo "[4b]   running: npm run build"
  npm run build 2>&1 | sed 's/^/[4b][npm run build] /'
  exit "${PIPESTATUS[0]}"
)
BUILD_RC=$?
set -e
info "[4b] build exit-code  : ${BUILD_RC}"
if [[ $BUILD_RC -ne 0 ]]; then
  die "[4b] npm run build failed (rc=${BUILD_RC}) in ${DEPLOY_DIR}. Service NOT stopped; previous runtime still active." 1
fi

info "[4b] post-build ls -lAh ${DEPLOY_DIR}/backend/dist"
ls -lAh "$DEPLOY_DIR/backend/dist" 2>&1 | sed 's/^/[4b]   /' || true
info "[4b] post-build find  ${DEPLOY_DIR}/backend/dist -maxdepth 2 -type f (first 20):"
find "$DEPLOY_DIR/backend/dist" -maxdepth 2 -type f 2>&1 | head -20 | sed 's/^/[4b]   /' || true
info "[4b] post-build ls -lAh ${DEPLOY_DIR}/frontend/admin/dist"
ls -lAh "$DEPLOY_DIR/frontend/admin/dist" 2>&1 | sed 's/^/[4b]   /' || true

# Defensive post-build assertion: confirm the runtime entry point exists
# in the deploy dir BEFORE we stop the service. If this fails we have
# nothing useful to rsync; abort cleanly with the existing service
# untouched.
if [[ ! -f "$DEPLOY_DIR/backend/dist/index.js" ]]; then
  die "[4b] Build completed (rc=0) but ${DEPLOY_DIR}/backend/dist/index.js is missing. Service NOT stopped; previous runtime still active." 1
fi
INDEX_BYTES="$(stat -c%s "$DEPLOY_DIR/backend/dist/index.js" 2>/dev/null || echo unknown)"
ok "[4b] dependencies installed, runtime built; ${DEPLOY_DIR}/backend/dist/index.js present (${INDEX_BYTES} bytes)"

w3forge_verify_workspace_links "$DEPLOY_DIR" || exit 3

# --- 5) Stop service ------------------------------------------------------
if systemctl is-active --quiet "$SERVICE_NAME"; then
  info "Stopping ${SERVICE_NAME}.service"
  if ! systemctl stop "$SERVICE_NAME"; then
    die "Failed to stop ${SERVICE_NAME}.service" 1
  fi
fi

# --- 6) Run DB migrations (ledger-aware, v0.12.11) ------------------------
#
# v0.12.11 correction: the migration runner now performs a strict
# PRE-LOOP baseline/bootstrap phase before it ever touches the
# database/migrations/*.sql loop. This prevents a pre-ledger v0.12.10
# production database from replaying migrations 001..015 solely because
# the ledger table did not yet exist at loop start.
#
# Sequence:
#
#   Step A. w3ledger_ensure_table
#           Idempotent CREATE TABLE IF NOT EXISTS for the ledger.
#
#   Step B. w3ledger_bootstrap_baseline
#           One-time historical baseline. Checks durable schema evidence
#           for migrations 001..015 and inserts NULL-checksum ledger
#           rows for the ones already applied. Empty databases record
#           nothing. Already-ledgered databases keep every existing row
#           (ON CONFLICT DO NOTHING). Non-NULL checksums are preserved.
#
#   Step C. w3ledger_apply_migrations
#           Lexical migration loop. Skips any migration recorded in the
#           ledger. On checksum mismatch for a recorded (non-NULL)
#           entry, fails closed. Otherwise applies with ON_ERROR_STOP=1
#           and records the on-disk SHA-256 only on success.
#
# All three functions live in scripts/_w3forge-migration-ledger.sh, which
# is also used by scripts/deploy-w3forge.sh so both runners are identical
# in behaviour.
MIGRATIONS_DIR="$DEPLOY_DIR/database/migrations"

# Step A: bootstrap ledger table.
w3ledger_ensure_table -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME"

# Step B: baseline historical migrations BEFORE the loop.
w3ledger_bootstrap_baseline -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME"

# Step C: ledger-aware migration loop.
w3ledger_apply_migrations "$MIGRATIONS_DIR" -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME"

# --- 7) Verify required W3 Forge tables (matches deploy-w3forge.sh) --
w3ledger_verify_required_tables -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME"

# --- 8) Sync runtime to /opt/w3forge (same excludes as deploy-w3forge.sh) ---
info "Syncing runtime files to ${APP_DIR}"
if ! rsync -a --delete \
  --exclude '.git' \
  --exclude '.env' \
  --exclude 'backups' \
  "$DEPLOY_DIR/" "$APP_DIR/"; then
  die "rsync to ${APP_DIR} failed." 1
fi
if [[ -d "$APP_DIR/.git" ]]; then
  warn "Removing unexpected runtime .git directory from $APP_DIR"
  rm -rf "$APP_DIR/.git"
fi

# --- 9) Update APP_VERSION in /opt/w3forge/.env ----------------------------
ENV_FILE="/etc/w3forge/admin.env"
touch "$ENV_FILE"
if grep -q '^APP_VERSION=' "$ENV_FILE"; then
  sed -i "s/^APP_VERSION=.*/APP_VERSION=${EXPECTED_NO_V}/" "$ENV_FILE"
else
  printf '\nAPP_VERSION=%s\n' "$EXPECTED_NO_V" >> "$ENV_FILE"
fi
ok "Wrote APP_VERSION=${EXPECTED_NO_V} to ${ENV_FILE}"

# --- 10) Restart service --------------------------------------------------
info "Starting ${SERVICE_NAME}.service"
if ! systemctl restart "$SERVICE_NAME"; then
  die "systemctl restart ${SERVICE_NAME} failed." 1
fi

# --- 11) Probe /health and /version (bounded retries) ---------------------
retry_endpoint() {
  local url="$1"
  local label="$2"
  local attempts=10
  local delay=3
  local i
  for ((i=1; i<=attempts; i++)); do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
      info "$label succeeded on attempt $i"
      return 0
    fi
    warn "$label failed on attempt $i/$attempts"
    sleep "$delay"
  done
  return 1
}

if retry_endpoint "$HEALTH_URL" "Health endpoint"; then
  HEALTH_OK="true"
else
  HEALTH_OK="false"
  die "Health endpoint did not recover after restart." 1
fi

if retry_endpoint "$VERSION_URL" "Version endpoint"; then
  VERSION_ENDPOINT_OK="true"
  # Best-effort: capture the deployed version reported by /version.
  DEPLOYED_VERSION="$(curl -fsS --max-time 5 "$VERSION_URL" 2>/dev/null | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  v=d.get("version") or d.get("APP_VERSION") or ""
  print(v.strip())
except Exception:
  pass' 2>/dev/null || echo "")"
  [[ -z "$DEPLOYED_VERSION" ]] && DEPLOYED_VERSION="$EXPECTED_NO_V"
else
  VERSION_ENDPOINT_OK="false"
  die "Version endpoint did not recover after restart." 1
fi

# --- 12) Write installed/<vX.Y.Z>/ metadata ------------------------------
# v0.5.38: a successful deploy records the installed metadata under the
# canonical layout. The tarball is copied (not moved) so the source
# channel still has the verified artifact for re-promotion / audit.
if declare -F pp_write_installed_metadata >/dev/null 2>&1; then
  if INSTALLED_DIR_OUT="$(PP_UPDATE_DIR="$UPDATE_DIR" pp_write_installed_metadata \
        "$TARGET_VERSION" "$PACKAGE_PATH" "$CHANNEL" "$REQUEST_ID" "${W3LOG_PATH:-}" 2>/dev/null)"; then
    ok "Installed metadata written to ${INSTALLED_DIR_OUT}"
  else
    warn "Failed to write installed metadata for ${TARGET_VERSION}; deploy itself succeeded."
    INSTALLED_DIR_OUT=""
  fi
fi

# --- 13) Success ----------------------------------------------------------
ok "Deploy complete: ${TARGET_VERSION} (channel=${CHANNEL})"
emit_trailer "success" "Deploy ${TARGET_VERSION} applied; service healthy."
if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
