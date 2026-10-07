#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"

# v0.4.5: structured logging initialization for status category.
# v0.4.4 shipped the closing w3log_done footer but accidentally omitted
# this header block, so status-w3forge.sh ran without ever calling
# w3log_init and no log file was created under /opt/logs/w3forge/status/.
# This block restores that initialization. Console output and the
# existing status behavior are preserved exactly.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-log.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"
fi
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "status"; fi

APP_NAME="W3 Forge"
APP_DIR="${W3_APP_DIR:-/opt/w3forge}"
DEPLOY_DIR="${W3_DEPLOY_DIR:-/opt/w3forge-deploy}"
BACKUP_DIR="${W3_BACKUPS_DIR:-/opt/backups/w3forge}"
SERVICE_NAME="${W3_SERVICE_NAME:-w3forge-admin.service}"
APP_PORT="${W3_SERVICE_PORT:-8765}"
HEALTH_URL="${W3_HEALTH_URL:-http://127.0.0.1:8765/health}"
VERSION_URL="${W3_VERSION_URL:-http://127.0.0.1:8765/version}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

section() {
  echo ""
  echo -e "${BLUE}=== $1 ===${NC}"
}

ok() {
  echo -e "${GREEN}[OK]${NC} $1"
}

warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

fail() {
  echo -e "${RED}[FAIL]${NC} $1"
}

echo ""
echo "=============================="
echo " W3 Forge Status Check"
echo "=============================="
echo "Time: $(date)"
echo ""

section "Systemd Service"

if systemctl is-active --quiet "$SERVICE_NAME"; then
  ok "$SERVICE_NAME.service is active"
else
  fail "$SERVICE_NAME.service is not active"
fi

systemctl status "$SERVICE_NAME" --no-pager -l | sed -n '1,12p'

section "Port Check"

if ss -tulpn | grep -q ":$APP_PORT"; then
  ok "Port $APP_PORT is listening"
  ss -tulpn | grep ":$APP_PORT"
else
  fail "Port $APP_PORT is not listening"
fi

section "Health Endpoint"

if HEALTH_RESPONSE=$(curl -fsS "$HEALTH_URL" 2>/dev/null); then
  ok "$HEALTH_URL responded"
  echo "$HEALTH_RESPONSE"
else
  fail "$HEALTH_URL failed"
fi

section "Version Endpoint"

if VERSION_RESPONSE=$(curl -fsS "$VERSION_URL" 2>/dev/null); then
  ok "$VERSION_URL responded"
  echo "$VERSION_RESPONSE"
else
  fail "$VERSION_URL failed"
fi

section "Database Connection"

if command -v pg_isready >/dev/null 2>&1; then
  if pg_isready -h 127.0.0.1 -p 5432 -d w3forge -U w3forge_user >/dev/null 2>&1; then
    ok "PostgreSQL is reachable for w3forge"
  else
    warn "PostgreSQL may not be reachable for w3forge_user"
  fi
else
  warn "pg_isready command not found"
fi

section "Production Files"

if [ -d "$APP_DIR" ]; then
  ok "$APP_DIR exists"
  ls -la "$APP_DIR" | sed -n '1,12p'
else
  fail "$APP_DIR does not exist"
fi

if [ -f "$APP_DIR/.env" ]; then
  ok "$APP_DIR/.env exists"
else
  fail "$APP_DIR/.env is missing"
fi

if [ -d "$APP_DIR/.git" ]; then
  warn "$APP_DIR/.git exists but production runtime should not contain a Git repo"
else
  ok "$APP_DIR does not contain .git"
fi

section "Installed Package Metadata"

# v0.5.38: surface /opt/w3forge-update-packages/installed/<v>/ sidecar files written
# by deploy-w3forge-noninteractive.sh / deploy-w3forge.sh on successful deploy.
# Read-only and informational. Shows the most recent canonical install dir
# (by mtime), with key sidecars if present.
INSTALLED_ROOT="${W3_INSTALLED_DIR:-/opt/w3forge-update-packages/installed}"
if [[ -d "$INSTALLED_ROOT" ]]; then
  LATEST_INSTALL_DIR="$(find "$INSTALLED_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'v*' -printf '%T@ %p\n' 2>/dev/null \
                       | sort -nr | head -n 1 | cut -d' ' -f2-)"
  if [[ -n "$LATEST_INSTALL_DIR" && -d "$LATEST_INSTALL_DIR" ]]; then
    ok "Latest installed version dir: $LATEST_INSTALL_DIR"
    for sidecar in deployed-at.txt source.txt request-id.txt log-path.txt sha256.txt; do
      if [[ -f "$LATEST_INSTALL_DIR/$sidecar" ]]; then
        printf '  %-18s : %s\n' "$sidecar" "$(tr -d '\n' < "$LATEST_INSTALL_DIR/$sidecar" | head -c 200)"
      fi
    done
    if [[ -f "$LATEST_INSTALL_DIR/w3forge.tar.gz" ]]; then
      ok "Package archive present (canonical name w3forge.tar.gz)"
    else
      LEGACY_ARCHIVE="$(find "$LATEST_INSTALL_DIR" -maxdepth 1 -type f -name 'w3forge-*.tar.gz' | head -n 1)"
      if [[ -n "$LEGACY_ARCHIVE" ]]; then
        warn "Canonical w3forge.tar.gz missing in latest install dir; legacy archive present: $LEGACY_ARCHIVE"
      else
        warn "No package archive found in $LATEST_INSTALL_DIR"
      fi
    fi
  else
    warn "$INSTALLED_ROOT exists but no canonical v* subdirectories yet"
  fi
else
  warn "$INSTALLED_ROOT does not exist"
fi

section "Git Repo Status"

if [ -d "$DEPLOY_DIR/.git" ]; then
  ok "$DEPLOY_DIR is a Git repo"
  cd "$DEPLOY_DIR" || exit 1
  echo "Branch: $(git branch --show-current)"
  echo "Latest commit: $(git log -1 --oneline)"
  echo "Latest tag: $(git tag --sort=-v:refname | head -n 1)"
  echo ""
  git status --short
else
  warn "$DEPLOY_DIR is not a Git repo"
fi

section "Disk Usage"

df -h / /opt 2>/dev/null | awk 'NR==1 || /\/$/ || /\/opt/'

section "Latest Local Backups"

if [ -d "$BACKUP_DIR" ]; then
  ls -lh "$BACKUP_DIR" | grep -E 'w3forge_app_|w3forge_db_' | tail -n 10 || warn "No W3 Forge backups found in $BACKUP_DIR"
else
  warn "$BACKUP_DIR does not exist"
fi

section "Recent Logs"

journalctl -u "$SERVICE_NAME" -n 20 --no-pager

echo ""
echo "=============================="
echo " W3 Forge Status Check Complete"
echo "=============================="
echo ""

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
