#!/usr/bin/env bash
# Canonical app+database backup workflow, with installation-owned destinations.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
w3forge_database_env
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_w3forge-log.sh"
w3log_init backup
APP_DIR="$W3_APP_DIR"
BACKUP_DIR="$W3_BACKUPS_DIR"
REMOTE_USER="$W3_BACKUP_REMOTE_USER"
REMOTE_HOST="$W3_BACKUP_REMOTE_HOST"
REMOTE_DIR="$W3_BACKUP_REMOTE_PATH"
DB_NAME="$W3_DB_NAME"
DB_USER="$W3_DB_USER"
TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
APP_BACKUP="w3forge_app_${TIMESTAMP}.tar.gz"
DB_BACKUP="w3forge_db_${TIMESTAMP}.sql"
printf '%s Starting W3 Forge backup\n' "$(date '+%Y-%m-%d %H:%M:%S')"
mkdir -p "$BACKUP_DIR"
# Keep the common archive root while reading only the configured runtime.
tar -czf "$BACKUP_DIR/$APP_BACKUP" \
  --exclude='./backups' --exclude='./.git' --exclude='*/.env' --exclude='*/.env.*' \
  --exclude='*/node_modules' --exclude='./backend/dist' --exclude='./frontend/admin/dist' \
  --exclude='*.log' --exclude='./tmp' \
  --transform 's,^\.,opt/w3forge,' -C "$APP_DIR" .
pg_dump -h "$W3_DB_HOST" -U "$DB_USER" -d "$DB_NAME" > "$BACKUP_DIR/$DB_BACKUP"
if [[ -n "$REMOTE_HOST" ]]; then
  ssh "$REMOTE_USER@$REMOTE_HOST" "mkdir -p '$REMOTE_DIR'"
  rsync -av "$BACKUP_DIR/$APP_BACKUP" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"
  rsync -av "$BACKUP_DIR/$DB_BACKUP" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"
  ssh "$REMOTE_USER@$REMOTE_HOST" "find '$REMOTE_DIR' -maxdepth 1 -type f \( -name 'w3forge_app_*.tar.gz' -o -name 'w3forge_db_*.sql' \) -mtime +7 -delete"
else
  echo '[INFO] Remote backup destination is not configured; local backup retained.'
fi
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'w3forge_app_*.tar.gz' -o -name 'w3forge_db_*.sql' \) -mtime +7 -delete
printf '%s Backup complete\n' "$(date '+%Y-%m-%d %H:%M:%S')"
printf '%s App backup: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$BACKUP_DIR/$APP_BACKUP"
printf '%s DB backup: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$BACKUP_DIR/$DB_BACKUP"
w3log_done
