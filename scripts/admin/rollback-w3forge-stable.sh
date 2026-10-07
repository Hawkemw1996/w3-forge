#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
w3forge_require_runtime_layout || exit 3
#
# rollback-w3forge-stable.sh
#
# W3 Core v0.5.19 — Terminal-only rollback to the last marked-stable
# package. Heavily guarded. NOT WIRED to the Admin Controls UI in v0.5.19
# and not eligible to be wired in v0.5.19. Future UI exposure (if ever)
# would require an approved Proposal and a separate release.
#
# Scope of this script (what it WILL do under --apply):
#   1. Read /opt/w3forge-stable/current-stable.json (or override).
#   2. Validate it points at a real, readable package archive (sha256
#      check when sha256sum is available and a sha was recorded).
#   3. Create a pre-rollback backup by invoking the EXISTING
#      /opt/w3forge-scripts/backup-w3forge.sh delegate (which is UNCHANGED in
#      v0.5.19). If that delegate is missing, refuse to proceed.
#   4. systemctl stop w3forge.service.
#   5. rsync the stable package's repo tree over /opt/w3forge, preserving
#      .git but excluding node_modules and dist (re-installed below).
#   6. Run `npm install --no-audit --no-fund` and `npm run build` inside
#      the restored /opt/w3forge tree.
#   7. systemctl start w3forge.service.
#   8. Poll /health and /version until they recover.
#
# Out-of-scope for this script (REFUSED even with --apply):
#   - Database restoration / migration / rollback.
#     The pre-rollback backup is the only DB write this script EVER
#     triggers (and that is via the unmodified backup delegate). DB
#     rollback remains a separate, proposal-only workflow that requires
#     explicit user approval. See docs/RELEASE_CANDIDATE_WORKFLOW_v0.5.19.md.
#   - Changing /opt/w3forge-scripts during rollback. Operator scripts are
#     reinstalled (if needed) by the existing install-server-scripts.sh
#     under the normal deploy path; rollback does not touch /opt/w3forge-scripts.
#   - Modifying systemd unit files, environment files, or secrets.
#   - Adding, removing, or upgrading dependencies beyond what the stable
#     package's package-lock.json already locks.
#
# Defaults to --dry-run. No mutation without ALL of:
#     --yes --confirm ROLLBACK --apply
#
# Exit codes:
#   0  rollback completed (or dry-run completed successfully)
#   1  rollback failed mid-flight
#   2  invalid arguments / refused confirmation
#   3  pre-flight failure (missing stable metadata or package archive)
#   4  /health did not recover after restart
#   5  /version did not recover after restart
#
# Logs to /opt/logs/w3forge/rollback/.
#
# Terminal-only. NOT WIRED to the Admin Controls UI in v0.5.19. The
# Admin Controls registry's existing 'restore-w3forge' entry remains
# DISABLED, and v0.5.19 does NOT add any UI-execution path for this
# script. Any future UI exposure must be proposed and approved
# separately.

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
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "rollback"; fi

# --- Config ----------------------------------------------------------------
APP_DIR="${W3_APP_DIR:-/opt/w3forge}"
METADATA_DIR="${W3_STABLE_DIR:-/opt/w3forge-stable}"
METADATA_FILE_DEFAULT="$METADATA_DIR/current-stable.json"
BACKUP_SCRIPT="${W3_BACKUP_SCRIPT:-/opt/w3forge-scripts/backup-w3forge.sh}"
SERVICE_NAME="${W3_SERVICE_NAME:-w3forge-admin.service}"
HEALTH_URL="${W3_HEALTH_URL:-http://localhost:8765/health}"
VERSION_URL="${W3_VERSION_URL:-http://localhost:8765/version}"
HEALTH_TIMEOUT_SECONDS="${W3_HEALTH_TIMEOUT:-60}"
POLL_INTERVAL="${W3_HEALTH_POLL:-2}"

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
  rollback-w3forge-stable.sh [options]
  rollback-w3forge-stable.sh help

REQUIRED for any live action:
  --yes                Non-interactive acknowledgement.
  --confirm ROLLBACK   Typed phrase confirmation. Exact string required.
  --apply              Perform the rollback. Without --apply, this is a
                       dry-run that prints the plan and exits 0.

Optional:
  --metadata-file <p>  Override default $METADATA_DIR/current-stable.json
  --service <name>     Default w3forge.
  --health-url <url>   Default http://localhost:8765/health.
  --version-url <url>  Default http://localhost:8765/version.

DOES roll back: the /opt/w3forge runtime tree to the last marked-stable
package; restarts the systemd service; runs smoke checks.

DOES NOT touch: the database (no migration, no restore — proposal-only),
the systemd unit files, /opt/w3forge-scripts, secrets/env files, or dependency
versions beyond what the stable package's lockfile already locks.

Terminal-only. NOT WIRED to the Admin Controls UI in v0.5.19. Future UI
exposure must be proposed and approved separately.
EOF
}

# --- Parse args ------------------------------------------------------------
YES=""
CONFIRM=""
APPLY=""
METADATA_FILE="$METADATA_FILE_DEFAULT"

while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    --yes) YES="1"; shift ;;
    --confirm)
      [[ $# -ge 2 ]] || { fail "--confirm requires a value"; exit 2; }
      CONFIRM="$2"; shift 2 ;;
    --apply) APPLY="1"; shift ;;
    --dry-run) APPLY=""; shift ;;
    --metadata-file)
      [[ $# -ge 2 ]] || { fail "--metadata-file requires a path"; exit 2; }
      METADATA_FILE="$2"; shift 2 ;;
    --service)
      [[ $# -ge 2 ]] || { fail "--service requires a value"; exit 2; }
      SERVICE_NAME="$2"; shift 2 ;;
    --health-url)
      [[ $# -ge 2 ]] || { fail "--health-url requires a value"; exit 2; }
      HEALTH_URL="$2"; shift 2 ;;
    --version-url)
      [[ $# -ge 2 ]] || { fail "--version-url requires a value"; exit 2; }
      VERSION_URL="$2"; shift 2 ;;
    *)
      fail "Unknown argument: $1"; usage; exit 2 ;;
  esac
done

# --- Confirmation gates ----------------------------------------------------
if [[ -z "$YES" ]]; then
  fail "Refusing to run without --yes (non-interactive acknowledgement required)"
  exit 2
fi
if [[ "$CONFIRM" != "ROLLBACK" ]]; then
  fail "Refusing to run without --confirm ROLLBACK (exact phrase required; got: '${CONFIRM:-<empty>}')"
  exit 2
fi

# --- Pre-flight: metadata + package ----------------------------------------
[[ -f "$METADATA_FILE" ]] || { fail "Stable metadata not found: $METADATA_FILE"; exit 3; }
command -v python3 >/dev/null 2>&1 || { fail "python3 is required to parse metadata"; exit 3; }

read_json_field() {
  local field="$1"
  python3 - "$METADATA_FILE" "$field" <<'PY' 2>/dev/null
import json,sys
with open(sys.argv[1]) as f: meta = json.load(f)
keys = sys.argv[2].split('.')
node = meta
for k in keys:
    if isinstance(node, dict) and k in node:
        node = node[k]
    else:
        node = ''
        break
print(node if node is not None else '')
PY
}

STABLE_PACKAGE="$(read_json_field 'package.path')"
STABLE_SHA256="$(read_json_field 'package.sha256')"
STABLE_APP_VERSION="$(read_json_field 'runtime.appVersion')"
STABLE_DEPLOY_VERSION="$(read_json_field 'runtime.deployVersion')"
MARKED_AT="$(read_json_field 'markedAt')"

[[ -n "$STABLE_PACKAGE" && "$STABLE_PACKAGE" != "<unknown>" ]] \
  || { fail "Stable metadata has no resolvable package.path"; exit 3; }

# v0.5.38: if recorded path is missing (e.g. operator moved files into the
# new canonical layout after marking stable), try the canonical fallback:
#   /opt/w3forge-update-packages/installed/<vAppVersion>/w3forge.tar.gz
# Discovery only — no mutation. If both paths fail, error out as before.
if [[ ! -f "$STABLE_PACKAGE" ]]; then
  INSTALLED_ROOT="${W3_INSTALLED_DIR:-/opt/w3forge-update-packages/installed}"
  if [[ -n "$STABLE_APP_VERSION" && "$STABLE_APP_VERSION" != "<unknown>" ]]; then
    VER_DIR_TAG="${STABLE_APP_VERSION}"
    case "$VER_DIR_TAG" in v*) ;; *) VER_DIR_TAG="v${VER_DIR_TAG}" ;; esac
    CANDIDATE="$INSTALLED_ROOT/$VER_DIR_TAG/w3forge.tar.gz"
    if [[ -f "$CANDIDATE" ]]; then
      warn "Recorded package.path not found; using canonical fallback: $CANDIDATE"
      STABLE_PACKAGE="$CANDIDATE"
    fi
  fi
fi
[[ -f "$STABLE_PACKAGE" ]] \
  || { fail "Stable package archive missing on disk: $STABLE_PACKAGE"; exit 3; }

if [[ -n "$STABLE_SHA256" && "$STABLE_SHA256" != "<unknown>" ]] && command -v sha256sum >/dev/null 2>&1; then
  CURRENT_SHA256="$(sha256sum "$STABLE_PACKAGE" | awk '{print $1}')"
  if [[ "$CURRENT_SHA256" != "$STABLE_SHA256" ]]; then
    fail "Stable package sha256 mismatch."
    fail "  metadata : $STABLE_SHA256"
    fail "  current  : $CURRENT_SHA256"
    exit 3
  fi
  ok "Stable package sha256 matches metadata"
fi

# --- Pre-flight: tooling ---------------------------------------------------
command -v systemctl >/dev/null 2>&1 || { fail "systemctl required";   exit 3; }
command -v rsync     >/dev/null 2>&1 || { fail "rsync required";       exit 3; }
command -v tar       >/dev/null 2>&1 || { fail "tar required";         exit 3; }
command -v curl      >/dev/null 2>&1 || { fail "curl required";        exit 3; }
command -v npm       >/dev/null 2>&1 || warn "npm missing; build step will be skipped"

[[ -d "$APP_DIR" ]] || { fail "App dir missing: $APP_DIR"; exit 3; }

# --- Print plan ------------------------------------------------------------
echo ""
echo "=============================="
echo " rollback-w3forge-stable PLAN"
echo "=============================="
echo " marked stable at  : $MARKED_AT"
echo " stable runtime ver: $STABLE_APP_VERSION  (deploy: $STABLE_DEPLOY_VERSION)"
echo " stable package    : $STABLE_PACKAGE"
echo " stable sha256     : ${STABLE_SHA256:-<unknown>}"
echo " app dir target    : $APP_DIR"
echo " service           : $SERVICE_NAME.service"
echo " health url        : $HEALTH_URL"
echo " version url       : $VERSION_URL"
echo ""
echo " Steps if --apply:"
echo "   1. invoke unchanged $BACKUP_SCRIPT (pre-rollback backup)"
echo "   2. systemctl stop $SERVICE_NAME"
echo "   3. rsync stable package's w3forge/ tree over $APP_DIR (preserve .git, exclude node_modules + dist)"
echo "   4. npm install + npm run build inside $APP_DIR (if npm available)"
echo "   5. systemctl start $SERVICE_NAME"
echo "   6. poll $HEALTH_URL + $VERSION_URL until recovered (timeout ${HEALTH_TIMEOUT_SECONDS}s)"
echo ""
echo " EXPLICITLY OUT OF SCOPE:"
echo "   - Database restore / migration / rollback (proposal-only)"
echo "   - Modifying /opt/w3forge-scripts, systemd unit files, secrets, or env files"
echo "   - Adding/removing/upgrading dependencies beyond stable lockfile"
echo ""

if [[ -z "$APPLY" ]]; then
  ok "Dry-run complete. Re-run with --apply to perform the rollback."
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 0
fi

# --- Apply ----------------------------------------------------------------
w3forge_verify_archive "$STABLE_PACKAGE" || exit 3
START_TS=$(date +%s)

# 1. Pre-rollback backup via UNMODIFIED delegate.
if [[ ! -x "$BACKUP_SCRIPT" ]]; then
  fail "Pre-rollback backup is required but $BACKUP_SCRIPT is missing or not executable."
  fail "Refusing to roll back without a fresh backup of the current runtime."
  exit 3
fi
info "Step 1/6: pre-rollback backup via $BACKUP_SCRIPT"
if ! "$BACKUP_SCRIPT"; then
  fail "Pre-rollback backup FAILED. Aborting before any mutation."
  exit 1
fi
ok "Pre-rollback backup complete"

# 2. Stop service.
info "Step 2/6: systemctl stop $SERVICE_NAME"
if ! systemctl stop "$SERVICE_NAME"; then
  fail "systemctl stop $SERVICE_NAME failed. Aborting."
  exit 1
fi
ok "Service stopped"

# 3. Extract stable package into stage dir, then rsync into $APP_DIR.
STAGE_DIR="$(mktemp -d -t w3forge-rollback.XXXXXX)"
cleanup_stage() { rm -rf "$STAGE_DIR" 2>/dev/null || true; }
trap cleanup_stage EXIT

info "Step 3/6: extract stable package to $STAGE_DIR"
case "$STABLE_PACKAGE" in
  *.tar.gz) tar -xzf "$STABLE_PACKAGE" -C "$STAGE_DIR" ;;
  *.zip)    command -v unzip >/dev/null 2>&1 || { fail "unzip required for .zip package"; exit 3; }
            unzip -q "$STABLE_PACKAGE" -d "$STAGE_DIR" ;;
  *) fail "Unsupported package format: $STABLE_PACKAGE"; exit 3 ;;
esac

# v0.5.38: canonical inner root is exactly w3forge/. Legacy packages used
# w3forge-<version>/. Both forms are accepted during transition.
STABLE_REPO_ROOT=""
if [[ -d "$STAGE_DIR/w3forge" ]]; then
  STABLE_REPO_ROOT="$STAGE_DIR/w3forge"
elif [[ -f "$STAGE_DIR/VERSION" && -f "$STAGE_DIR/package.json" ]]; then
  STABLE_REPO_ROOT="$STAGE_DIR"
else
  LEGACY="$(find "$STAGE_DIR" -mindepth 1 -maxdepth 1 -type d -name 'w3forge-*' | head -n 1)"
  if [[ -n "$LEGACY" && -d "$LEGACY" ]]; then
    STABLE_REPO_ROOT="$LEGACY"
  else
    CANDIDATE="$(find "$STAGE_DIR" -mindepth 1 -maxdepth 2 -type f -name VERSION | head -n 1 | xargs -r dirname)"
    STABLE_REPO_ROOT="${CANDIDATE:-}"
  fi
fi
[[ -n "$STABLE_REPO_ROOT" && -d "$STABLE_REPO_ROOT" ]] \
  || { fail "Could not locate repo root inside extracted package"; exit 1; }

info "Step 3/6: rsync $STABLE_REPO_ROOT/ -> $APP_DIR/ (preserve .git, exclude node_modules + dist)"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'backend/node_modules' \
  --exclude 'frontend/node_modules' \
  --exclude 'backend/dist' \
  --exclude 'frontend/admin/dist' \
  "$STABLE_REPO_ROOT/" "$APP_DIR/"
ok "Runtime tree restored"

# 4. npm install + build.
if command -v npm >/dev/null 2>&1; then
  info "Step 4/6: npm install --no-audit --no-fund"
  ( cd "$APP_DIR" && npm install --no-audit --no-fund )
  info "Step 4/6: npm run build"
  ( cd "$APP_DIR" && npm run build )
  ok "npm install + build complete"
else
  warn "Step 4/6: npm missing; skipped install/build (operator must run them manually before next deploy)"
fi

# 5. Start service.
info "Step 5/6: systemctl start $SERVICE_NAME"
if ! systemctl start "$SERVICE_NAME"; then
  fail "systemctl start $SERVICE_NAME failed."
  exit 1
fi
ok "Service started"

# 6. Smoke checks.
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

info "Step 6/6: poll $HEALTH_URL"
if ! poll "$HEALTH_URL" "/health"; then
  fail "/health did not recover within ${HEALTH_TIMEOUT_SECONDS}s after rollback"
  exit 4
fi
info "Step 6/6: poll $VERSION_URL"
if ! poll "$VERSION_URL" "/version"; then
  fail "/version did not recover within ${HEALTH_TIMEOUT_SECONDS}s after rollback"
  exit 5
fi

END_TS=$(date +%s)
DURATION=$(( END_TS - START_TS ))

echo ""
echo "=============================="
echo " rollback-w3forge-stable DONE"
echo "=============================="
echo " duration_seconds : $DURATION"
echo " stable version   : $STABLE_APP_VERSION"
echo " package          : $STABLE_PACKAGE"
echo " service          : $SERVICE_NAME (started)"
echo ""
echo " NOTE: database was NOT modified by this script. If the deploy that"
echo "       is being rolled back included migrations or DB writes, those"
echo "       still need a separate, approved DB-restore workflow."
echo ""

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
