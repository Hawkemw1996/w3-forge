#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
w3forge_database_env
w3forge_require_runtime_layout || exit 3
set -euo pipefail

# ============================================================================
# scripts/deploy-w3forge.sh
#
# v0.5.27: Runtime deploy and Git release promotion are SEPARATE.
#
# DEFAULT behavior (no flags): runtime deploy ONLY.
#   - Imports the staged package, takes a backup, installs/builds,
#     installs operational scripts, rsyncs the runtime, runs migrations,
#     restarts the service, and verifies /health + /version.
#   - DOES NOT git commit, DOES NOT git tag, DOES NOT git push.
#   - Runtime deploy success/failure does NOT depend on remote tag/branch
#     state. A pre-existing remote tag CANNOT cause this default flow to
#     fail.
#
# OPT-IN behavior (--promote-git-release | --push-tag | --git-release):
#   - In addition to the runtime deploy, creates an annotated git tag for
#     the deployed version and pushes the branch + tag to origin.
#   - Requires a SEPARATE confirmation (typed "PROMOTE").
#   - Git operations are idempotent and tolerant: an existing local tag is
#     updated to the current commit; a remote tag/branch push that
#     "rejects (already exists)" is logged as a WARNING, not a failure,
#     and does NOT roll back the completed runtime deploy.
#
# UI deploy path (scripts/deploy-w3forge-ui.sh -> deploy-w3forge-noninteractive.sh)
# is unchanged by v0.5.27 and continues to never touch git tags/branches.
#
# v0.4.4: additive structured logging to /opt/logs/w3forge/deploy/.
# The legacy /var/log/w3forge-deploy.log line writer below is preserved
# unchanged for backward compatibility. This helper only adds a tee'd
# full-session log file under the new /opt/logs/w3forge/ standard.
#
# v0.5.38: package layout under /opt/w3forge-update-packages/ now supports the
# canonical channel/version model:
#
#   /opt/w3forge-update-packages/<channel>/<version>/w3forge.tar.gz
#       channel ∈ { dev, main, installed }
#
# find_latest_package() and archive_imported_package() are extended to
# scan and write the new layout while remaining backward-compatible with
# the legacy flat layout (top-level w3forge-vX.Y.Z.tar.gz). The operator
# confirmation flow (Type DEPLOY / Type PROMOTE) is unchanged.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-log.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"
fi
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "deploy"; fi

# v0.12.11: shared migration ledger helper. Provides
# w3ledger_ensure_table / w3ledger_bootstrap_baseline / w3ledger_apply_migrations.
# Both deploy runners source the same helper so their migration
# behaviour is identical.
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

APP_DIR="${W3_APP_DIR:-/opt/w3forge}"
DEPLOY_DIR="${W3_DEPLOY_DIR:-/opt/w3forge-deploy}"
SCRIPTS_DIR="${W3_SCRIPTS_DIR:-/opt/w3forge-scripts}"
UPDATE_DIR="${W3_UPDATE_DIR:-/opt/w3forge-update-packages}"
INSTALLED_DIR="${W3_INSTALLED_DIR:-/opt/w3forge-update-packages/installed}"
MAIN_CHANNEL_DIR="${W3_MAIN_UPDATE_DIR:-/opt/w3forge-update-packages/main}"            # v0.5.38
DEV_CHANNEL_DIR="${W3_DEV_UPDATE_DIR:-/opt/w3forge-update-packages/dev}"              # v0.5.38
CANONICAL_PACKAGE_NAME="w3forge.tar.gz"                  # v0.5.38
REPO_BACKUP_DIR_BASE="/opt/w3forge-update-package-backups"
SERVICE_NAME="${W3_SERVICE_NAME:-w3forge-admin.service}"
DEFAULT_BRANCH="main"
HEALTH_URL="${W3_HEALTH_URL:-http://127.0.0.1:8765/health}"
VERSION_URL="${W3_VERSION_URL:-http://127.0.0.1:8765/version}"
LOG_FILE="/var/log/w3forge-deploy.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_line() {
  local level="$1"
  shift
  echo "$(date '+%Y-%m-%d %H:%M:%S') [$level] $*" >> "$LOG_FILE"
}
info() { echo -e "${BLUE}[INFO]${NC} $*"; log_line INFO "$*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; log_line OK "$*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; log_line WARN "$*"; }
fail() { echo -e "${RED}[ERROR]${NC} $*"; log_line ERROR "$*"; exit 1; }

# ----------------------------------------------------------------------------
# Argument parsing (v0.5.27)
# ----------------------------------------------------------------------------
PROMOTE_GIT="no"
SHOW_HELP="no"

print_help() {
  cat <<'HELP'
deploy-w3forge.sh — W3 Forge runtime deployer

Usage:
  deploy-w3forge.sh [--promote-git-release | --push-tag | --git-release]
  deploy-w3forge.sh --help | -h

Default behavior (no flags):
  Runtime deploy only. Imports the staged package (if any), takes a
  pre-deploy backup, installs/builds, installs operational scripts,
  rsyncs the runtime, runs migrations, restarts the service, and
  verifies /health + /version. DOES NOT git commit/tag/push. A
  pre-existing remote tag or branch state cannot cause this flow to
  fail.

Opt-in flag (--promote-git-release, --push-tag, --git-release):
  In addition to the runtime deploy above, creates an annotated git
  tag for the deployed version and pushes the active branch + tag to
  origin. Requires typing PROMOTE at the separate Git-promotion
  confirmation prompt. Idempotent: an existing local tag is moved to
  the current commit; a remote tag/branch push that is rejected
  because the ref already exists is reported as a WARNING and does
  NOT roll back the completed runtime deploy.

Examples:
  # Standard runtime deploy (no git changes):
  /opt/w3forge-scripts/deploy-w3forge.sh

  # Runtime deploy AND promote/tag/push the release:
  /opt/w3forge-scripts/deploy-w3forge.sh --promote-git-release
HELP
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --promote-git-release|--push-tag|--git-release)
      PROMOTE_GIT="yes"
      shift
      ;;
    --help|-h|help)
      SHOW_HELP="yes"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Run with --help for usage." >&2
      exit 2
      ;;
  esac
done

if [[ "$SHOW_HELP" == "yes" ]]; then
  print_help
  exit 0
fi

# ----------------------------------------------------------------------------
# Helpers (unchanged behavior from v0.5.26 unless noted)
# ----------------------------------------------------------------------------
find_latest_package() {
  # v0.5.38: search BOTH the new canonical channel/version layout AND the
  # legacy flat layout. Picks the newest by mtime across all candidates so
  # operators using either layout get expected behavior. Channels searched:
  # main (preferred for releases), then dev, then legacy flat root, then
  # installed (so a rollback-like re-import still works).
  {
    # Canonical: /opt/w3forge-update-packages/<channel>/<version>/w3forge.tar.gz
    for channel_dir in "$MAIN_CHANNEL_DIR" "$DEV_CHANNEL_DIR" "$INSTALLED_DIR"; do
      [[ -d "$channel_dir" ]] || continue
      find "$channel_dir" -mindepth 2 -maxdepth 2 -type f \
        \( -name "$CANONICAL_PACKAGE_NAME" -o -name 'w3forge-*.tar.gz' -o -name 'w3forge-*.zip' \) \
        -printf '%T@ %p\n' 2>/dev/null
    done
    # Legacy: /opt/w3forge-update-packages/<channel>/w3forge-vX.Y.Z.tar.gz
    for channel_dir in "$MAIN_CHANNEL_DIR" "$DEV_CHANNEL_DIR"; do
      [[ -d "$channel_dir" ]] || continue
      find "$channel_dir" -maxdepth 1 -type f \
        \( -name 'w3forge-*.tar.gz' -o -name 'w3forge-*.zip' \) \
        -printf '%T@ %p\n' 2>/dev/null
    done
    # Legacy: /opt/w3forge-update-packages/w3forge-vX.Y.Z.tar.gz (flat root)
    find "$UPDATE_DIR" -maxdepth 1 -type f \
      \( -name 'w3forge-*.tar.gz' -o -name 'w3forge-*.zip' \) \
      -printf '%T@ %p\n' 2>/dev/null
  } | sort -nr | head -n 1 | cut -d' ' -f2-
}

extract_package() {
  local package_path="$1"
  w3forge_verify_archive "$package_path" || return 3
  local target_dir="$2"
  case "$package_path" in
    *.tar.gz) tar -xzf "$package_path" -C "$target_dir" ;;
    *.zip) unzip -q "$package_path" -d "$target_dir" ;;
    *) fail "Unsupported package format: $package_path" ;;
  esac
}

resolve_repo_root() {
  local extract_dir="$1"
  if [[ -d "$extract_dir/w3forge" ]]; then
    echo "$extract_dir/w3forge"
    return
  fi
  if [[ -f "$extract_dir/VERSION" && -f "$extract_dir/package.json" ]]; then
    echo "$extract_dir"
    return
  fi
  local candidate
  candidate="$(find "$extract_dir" -mindepth 1 -maxdepth 2 -type f -name VERSION | head -n 1 | xargs -r dirname)"
  [[ -n "$candidate" ]] || fail "Could not detect extracted repo root"
  echo "$candidate"
}

verify_repo_shape() {
  local repo_root="$1"
  [[ -f "$repo_root/VERSION" ]] || fail "VERSION not found"
  [[ -f "$repo_root/package.json" ]] || fail "package.json not found"
  [[ -d "$repo_root/backend" ]] || fail "backend/ not found"
  [[ -d "$repo_root/frontend" ]] || fail "frontend/ not found"
  [[ -d "$repo_root/database" ]] || fail "database/ not found"
  [[ -d "$repo_root/scripts" ]] || fail "scripts/ not found"
}

read_json_version() {
  local json_file="$1"
  python3 - <<PY
import json
with open('$json_file','r') as f:
    print(json.load(f).get('version','').strip())
PY
}

verify_version_alignment() {
  local expected="$1"
  local repo_dir="$2"
  local version_file pkg_version backend_version frontend_version
  version_file="$(tr -d '[:space:]' < "$repo_dir/VERSION")"
  pkg_version="$(read_json_version "$repo_dir/package.json")"
  backend_version="$(read_json_version "$repo_dir/backend/package.json")"
  frontend_version="$(read_json_version "$repo_dir/frontend/admin/package.json")"

  [[ "$version_file" == "$expected" ]] || fail "VERSION mismatch: expected $expected but found $version_file"
  [[ "$pkg_version" == "$expected" ]] || fail "package.json mismatch: expected $expected but found $pkg_version"
  [[ "$backend_version" == "$expected" ]] || fail "backend/package.json mismatch: expected $expected but found $backend_version"
  [[ "$frontend_version" == "$expected" ]] || fail "frontend/admin/package.json mismatch: expected $expected but found $frontend_version"
}

update_app_version_in_env() {
  local env_file="$1"
  local version_value="$2"
  touch "$env_file"
  if grep -q '^APP_VERSION=' "$env_file"; then
    sed -i "s/^APP_VERSION=.*/APP_VERSION=${version_value}/" "$env_file"
  else
    printf '\nAPP_VERSION=%s\n' "$version_value" >> "$env_file"
  fi
}

retry_endpoint() {
  local url="$1"
  local label="$2"
  local attempts=10
  local delay=3
  local i
  for ((i=1; i<=attempts; i++)); do
    if curl -fsS "$url" >/dev/null; then
      info "$label succeeded on attempt $i"
      return 0
    fi
    warn "$label failed on attempt $i/$attempts"
    sleep "$delay"
  done
  return 1
}

run_sql_migrations() {
  # v0.12.11: ledger-aware migration runner with a strict pre-loop
  # baseline. Delegates to the shared helper functions in
  # scripts/_w3forge-migration-ledger.sh so both operator and UI paths
  # execute the identical sequence:
  #
  #   Step A: w3ledger_ensure_table       (idempotent ledger DDL)
  #   Step B: w3ledger_bootstrap_baseline (record historical baselines
  #                                        BEFORE the migration loop)
  #   Step C: w3ledger_apply_migrations   (lexical loop, skipping
  #                                        recorded migrations, fail-
  #                                        closed on checksum mismatch,
  #                                        SHA-256 record on success)
  local migrations_dir="$DEPLOY_DIR/database/migrations"
  [[ -d "$migrations_dir" ]] || { warn "No migrations directory found at $migrations_dir"; return 0; }

  # Interactive path uses fixed local-Postgres connection params.
  local -a conn=( -h "$W3_DB_HOST" -U "$W3_DB_USER" -d "$W3_DB_NAME" )

  w3ledger_ensure_table "${conn[@]}"
  w3ledger_bootstrap_baseline "${conn[@]}"
  w3ledger_apply_migrations "$migrations_dir" "${conn[@]}"

  # v0.4.3: database/seeds is operator-managed and is not run automatically.
  # The deploy script intentionally does not execute anything under
  # database/seeds. Bootstrap / reference data lives there as .sql.example
  # files that an operator may run manually with psql if ever needed.
  local seeds_dir="$DEPLOY_DIR/database/seeds"
  if [[ -d "$seeds_dir" ]]; then
    info "database/seeds is operator-managed and is not run automatically"
  fi
}

verify_required_columns() {
  # W3 Forge schema check (shared with the non-interactive deploy).
  w3ledger_verify_required_tables -h "$W3_DB_HOST" -U "$W3_DB_USER" -d "$W3_DB_NAME"
}

install_dependencies() {
  if [[ -f package-lock.json ]]; then
    info "Installing dependencies with npm ci"
    npm ci
  else
    info "Installing dependencies with npm install"
    npm install
  fi
}

# v0.5.27: commit-before-promotion is only used in the opt-in
# Git-promotion path. It is no longer part of the default runtime deploy.
commit_repo_changes_if_needed() {
  if [[ -n "$(git status --porcelain)" ]]; then
    info "Committing repo changes before tag creation"
    git add .
    git commit -m "$DEPLOY_MESSAGE"
  else
    warn "No repo changes to commit"
  fi
}

archive_imported_package() {
  local package_path="$1"
  [[ -n "$package_path" ]] || return 0
  mkdir -p "$INSTALLED_DIR"

  local base_name target_path
  base_name="$(basename "$package_path")"

  # v0.5.38: prefer the canonical installed/<version>/w3forge.tar.gz layout
  # when we know the version. Fall back to the legacy installed/<basename>
  # layout for backward compatibility (e.g. when an older operator imports
  # a legacy w3forge-vX.Y.Z.tar.gz).
  local version_for_archive=""
  if [[ -n "${VERSION_NO_V:-}" ]]; then
    version_for_archive="v${VERSION_NO_V}"
  elif [[ -n "${PACKAGE_VERSION:-}" ]]; then
    version_for_archive="v${PACKAGE_VERSION}"
  elif [[ "$base_name" =~ ^w3forge-(v[0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz$ ]]; then
    version_for_archive="${BASH_REMATCH[1]}"
  fi

  if [[ -n "$version_for_archive" ]]; then
    local canonical_dir="$INSTALLED_DIR/$version_for_archive"
    mkdir -p "$canonical_dir"
    target_path="$canonical_dir/$CANONICAL_PACKAGE_NAME"
    if [[ -e "$target_path" ]]; then
      local stamp
      stamp="$(date +%Y-%m-%d_%H-%M-%S)"
      target_path="$canonical_dir/${CANONICAL_PACKAGE_NAME%.tar.gz}-${stamp}.tar.gz"
    fi
    mv "$package_path" "$target_path"
    # Best-effort installed-metadata sidecars (matches pp_write_installed_metadata).
    {
      printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$canonical_dir/deployed-at.txt" 2>/dev/null || true
      printf '%s\n' "deploy-w3forge.sh (operator)"     > "$canonical_dir/source.txt"      2>/dev/null || true
      command -v sha256sum >/dev/null 2>&1 && sha256sum "$target_path" | awk '{print $1}' > "$canonical_dir/sha256.txt" 2>/dev/null || true
    } || true
    info "Archived imported package to $target_path (canonical layout)"
    INSTALLED_PACKAGE_PATH="$target_path"
    return 0
  fi

  # Legacy fallback (no version known): place flat under installed/.
  target_path="$INSTALLED_DIR/$base_name"
  if [[ -e "$target_path" ]]; then
    local stamp name ext
    stamp="$(date +%Y-%m-%d_%H-%M-%S)"
    if [[ "$base_name" == *.tar.gz ]]; then
      name="${base_name%.tar.gz}"
      ext=".tar.gz"
    else
      name="${base_name%.*}"
      ext=".${base_name##*.}"
    fi
    target_path="$INSTALLED_DIR/${name}-${stamp}${ext}"
  fi
  mv "$package_path" "$target_path"
  info "Archived imported package to $target_path (legacy layout)"
  INSTALLED_PACKAGE_PATH="$target_path"
}

# v0.5.27: opt-in Git release promotion (idempotent, tolerant).
# Runs ONLY when --promote-git-release was passed AND the operator types
# PROMOTE at the separate confirmation prompt. A failure here is treated
# as a WARNING. It never rolls back the already-completed runtime deploy.
promote_git_release() {
  local tag_version="$1"
  local deploy_message="$2"

  echo ""
  echo "------------------------------------------------------------"
  echo " Git release promotion (opt-in)"
  echo "------------------------------------------------------------"
  echo "Tag to create/update : $tag_version"
  echo "Branch to push       : $DEFAULT_BRANCH"
  echo "Commit message       : $deploy_message"
  echo ""
  read -r -p "Type PROMOTE to commit/tag/push this release (anything else skips): " PROMOTE_CONFIRM
  if [[ "$PROMOTE_CONFIRM" != "PROMOTE" ]]; then
    warn "Git promotion skipped (confirmation not provided)."
    GIT_PROMOTION_RESULT="skipped (confirmation declined)"
    return 0
  fi

  cd "$DEPLOY_DIR"

  # Best-effort commit. Failures are downgraded to WARNING.
  if [[ -n "$(git status --porcelain)" ]]; then
    info "Committing repo changes before tag creation"
    if ! git add . || ! git commit -m "$deploy_message"; then
      warn "git commit failed; continuing with promotion attempt"
    fi
  else
    info "No repo changes to commit"
  fi

  # Idempotent local tag: if it already exists, move it to HEAD.
  if git rev-parse "$tag_version" >/dev/null 2>&1; then
    warn "Local tag $tag_version already exists; moving it to the current commit"
    git tag -d "$tag_version" >/dev/null 2>&1 || true
  fi
  if ! git tag -a "$tag_version" -m "$deploy_message"; then
    warn "git tag -a $tag_version failed; skipping push step"
    GIT_PROMOTION_RESULT="failed (tag creation)"
    return 0
  fi
  success "Local annotated tag $tag_version created"

  # Branch push: tolerate non-fast-forward / missing remote.
  if git push origin "$DEFAULT_BRANCH"; then
    success "Pushed branch $DEFAULT_BRANCH"
  else
    warn "git push origin $DEFAULT_BRANCH failed; runtime deploy is NOT rolled back"
  fi

  # Tag push: tolerate already-exists / rejected.
  if git push origin "$tag_version"; then
    success "Pushed tag $tag_version"
    GIT_PROMOTION_RESULT="committed, tagged, and pushed"
  else
    warn "git push origin $tag_version failed (remote tag may already exist); runtime deploy is NOT rolled back"
    warn "To inspect remote tag state run: git ls-remote --tags origin $tag_version"
    GIT_PROMOTION_RESULT="tagged locally; remote push rejected (likely already exists)"
  fi
}

# ----------------------------------------------------------------------------
# Pre-flight
# ----------------------------------------------------------------------------
mkdir -p "$UPDATE_DIR" "$INSTALLED_DIR" "$MAIN_CHANNEL_DIR" "$DEV_CHANNEL_DIR" "$REPO_BACKUP_DIR_BASE" "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"
[[ -d "$DEPLOY_DIR/.git" ]] || fail "$DEPLOY_DIR is not a git checkout"
[[ -d "$APP_DIR" ]] || fail "$APP_DIR does not exist"

PACKAGE_PATH="$(find_latest_package || true)"
PACKAGE_VERSION=""
PACKAGE_IMPORTED="no"
INSTALLED_PACKAGE_PATH="not moved"
TMP_DIR=""
PACKAGE_ROOT=""
REPO_BACKUP_DIR=""
GIT_PROMOTION_RESULT="skipped (default behavior; runtime-only)"
trap '[[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]] && rm -rf "$TMP_DIR"' EXIT

# ----------------------------------------------------------------------------
# Step 1: optional package import (interactive)
# ----------------------------------------------------------------------------
if [[ -n "$PACKAGE_PATH" ]]; then
  info "Found package: $PACKAGE_PATH"
  read -r -p "Import this package before deploy? [y/N] " IMPORT_PACKAGE
  if [[ "$IMPORT_PACKAGE" =~ ^[Yy]$ ]]; then
    TMP_DIR="$(mktemp -d /tmp/w3forge-deploy-package.XXXXXX)"
    extract_package "$PACKAGE_PATH" "$TMP_DIR"
    PACKAGE_ROOT="$(resolve_repo_root "$TMP_DIR")"
    verify_repo_shape "$PACKAGE_ROOT"
    chmod +x "$PACKAGE_ROOT/scripts"/*.sh
    bash -n "$PACKAGE_ROOT/scripts"/*.sh
    PACKAGE_VERSION="$(tr -d '[:space:]' < "$PACKAGE_ROOT/VERSION")"
    [[ -n "$PACKAGE_VERSION" ]] || fail "Package VERSION is empty"
    verify_version_alignment "$PACKAGE_VERSION" "$PACKAGE_ROOT"

    REPO_BACKUP_DIR="$REPO_BACKUP_DIR_BASE/w3forge-deploy-$(date +%Y-%m-%d_%H-%M-%S)"
    mkdir -p "$REPO_BACKUP_DIR"
    info "Backing up current deploy repo contents to $REPO_BACKUP_DIR"
    rsync -a --exclude '.git' "$DEPLOY_DIR/" "$REPO_BACKUP_DIR/"

    info "Importing package into $DEPLOY_DIR while preserving .git"
    rsync -a --delete --exclude '.git' "$PACKAGE_ROOT/" "$DEPLOY_DIR/"
    chown -R root:root "$DEPLOY_DIR"
    chmod +x "$DEPLOY_DIR/scripts"/*.sh
    bash -n "$DEPLOY_DIR/scripts"/*.sh
    bash "$DEPLOY_DIR/scripts/admin/install-server-scripts.sh"
    PACKAGE_IMPORTED="yes"
  fi
fi

cd "$DEPLOY_DIR"
CURRENT_VERSION="$(tr -d '[:space:]' < VERSION)"
DEFAULT_VERSION="v${PACKAGE_VERSION:-$CURRENT_VERSION}"
read -r -p "Enter version [$DEFAULT_VERSION]: " VERSION_INPUT
VERSION_INPUT="${VERSION_INPUT:-$DEFAULT_VERSION}"
VERSION_NO_V="${VERSION_INPUT#v}"
TAG_VERSION="v${VERSION_NO_V}"
read -r -p "Enter deploy message: " DEPLOY_MESSAGE
[[ -n "$DEPLOY_MESSAGE" ]] || DEPLOY_MESSAGE="Deploy W3 Forge $TAG_VERSION"

verify_version_alignment "$VERSION_NO_V" "$DEPLOY_DIR"
w3forge_verify_workspace_links "$DEPLOY_DIR" || exit 3

# ----------------------------------------------------------------------------
# Step 2: deployment confirmation
# ----------------------------------------------------------------------------
printf '\nDeployment summary:\n'
printf 'Package imported : %s\n' "$PACKAGE_IMPORTED"
printf 'Package path     : %s\n' "${PACKAGE_PATH:-none}"
printf 'Repo version     : %s\n' "$CURRENT_VERSION"
printf 'Deploy version   : %s\n' "$VERSION_NO_V"
printf 'Target tag       : %s\n' "$TAG_VERSION"
printf 'Deploy message   : %s\n' "$DEPLOY_MESSAGE"
printf 'Git promotion    : %s\n' "$([[ "$PROMOTE_GIT" == "yes" ]] && echo 'YES (opt-in via --promote-git-release)' || echo 'NO (runtime-only, default)')"
printf '\n'
read -r -p "Type DEPLOY to continue: " CONFIRM
[[ "$CONFIRM" == "DEPLOY" ]] || fail "Deployment cancelled"

info "Git status before install/build (informational only)"
git status --short || true

# ----------------------------------------------------------------------------
# Step 3: install + build (runtime-deploy core)
# ----------------------------------------------------------------------------
install_dependencies
info "Running build"
npm run build

verify_version_alignment "$VERSION_NO_V" "$DEPLOY_DIR"

# ----------------------------------------------------------------------------
# Step 4: pre-sync backup (runtime-deploy core)
# ----------------------------------------------------------------------------
if systemctl is-active --quiet "$SERVICE_NAME"; then
  info "Stopping $SERVICE_NAME.service"
  systemctl stop "$SERVICE_NAME"
fi

if [[ -x "$SCRIPTS_DIR/backup-w3forge.sh" ]]; then
  info "Running pre-sync backup"
  "$SCRIPTS_DIR/backup-w3forge.sh"
else
  warn "backup-w3forge.sh not found in $SCRIPTS_DIR; skipping pre-sync backup"
fi

# ----------------------------------------------------------------------------
# Step 5: migrations + schema verify (runtime-deploy core)
# ----------------------------------------------------------------------------
run_sql_migrations
verify_required_columns

# ----------------------------------------------------------------------------
# Step 6: runtime sync (runtime-deploy core)
# ----------------------------------------------------------------------------
info "Syncing runtime files to $APP_DIR"
rsync -a --delete \
  --exclude '.git' \
  --exclude '.env' \
  --exclude 'backups' \
  "$DEPLOY_DIR/" "$APP_DIR/"

if [[ -d "$APP_DIR/.git" ]]; then
  warn "Removing unexpected runtime .git directory from $APP_DIR"
  rm -rf "$APP_DIR/.git"
fi

update_app_version_in_env "/etc/w3forge/admin.env" "$VERSION_NO_V"

# ----------------------------------------------------------------------------
# Step 7: restart + health/version verify (runtime-deploy core)
# ----------------------------------------------------------------------------
info "Starting $SERVICE_NAME.service"
systemctl restart "$SERVICE_NAME"
retry_endpoint "$HEALTH_URL" "Health endpoint" || fail "Health endpoint did not recover"
retry_endpoint "$VERSION_URL" "Version endpoint" || fail "Version endpoint did not recover"

if [[ -x "$SCRIPTS_DIR/backup-w3forge.sh" ]]; then
  info "Running post-deploy backup"
  "$SCRIPTS_DIR/backup-w3forge.sh"
fi

# ----------------------------------------------------------------------------
# Step 8: archive imported package (runtime-deploy core)
# ----------------------------------------------------------------------------
if [[ "$PACKAGE_IMPORTED" == "yes" ]]; then
  archive_imported_package "$PACKAGE_PATH"
fi

# ----------------------------------------------------------------------------
# Step 9: OPT-IN Git release promotion (skipped by default)
# ----------------------------------------------------------------------------
if [[ "$PROMOTE_GIT" == "yes" ]]; then
  promote_git_release "$TAG_VERSION" "$DEPLOY_MESSAGE"
fi

# ----------------------------------------------------------------------------
# Final summary
# ----------------------------------------------------------------------------
success "Runtime deployment completed successfully."
if [[ "$PROMOTE_GIT" == "yes" ]]; then
  info "Git release promotion attempted: ${GIT_PROMOTION_RESULT}"
else
  info "Git release promotion skipped (default behavior)."
  info "To promote/tag/push this release, run:"
  info "  /opt/w3forge-scripts/deploy-w3forge.sh --promote-git-release"
fi

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi

echo ""
echo "=============================="
echo " W3 Forge Deploy Complete"
echo "=============================="
echo "Package imported : $PACKAGE_IMPORTED"
echo "Version          : $VERSION_NO_V"
echo "Target tag       : $TAG_VERSION"
echo "Repo             : $DEPLOY_DIR"
echo "Runtime          : $APP_DIR"
echo "Health           : $HEALTH_URL"
echo "Version URL      : $VERSION_URL"
echo "Installed pkg    : $INSTALLED_PACKAGE_PATH"
echo "Git promotion    : $GIT_PROMOTION_RESULT"
echo ""
