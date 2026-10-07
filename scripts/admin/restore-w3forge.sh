#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
w3forge_database_env
w3forge_require_runtime_layout || exit 3
set -euo pipefail

# =============================================================================
# W3 Core v0.5.24 - Restore From Backup delegate.
# =============================================================================
#
# v0.4.4: additive structured logging to /opt/logs/w3forge/restore/.
# v0.4.8: optional --dry-run flag. Additive, non-destructive. When set, the
#         script resolves the newest local pair (or args) and prints exactly
#         what would happen, then exits 0 without any system mutation.
# v0.5.24: additive --non-interactive apply mode. Drives the same apply path
#          as the interactive mode but takes its inputs entirely from flags
#          (`--app <basename>`, `--db <basename>`,
#          `--yes-i-understand-this-replaces-production`,
#          `--request-id <opaque>`), reads no stdin, and emits a structured
#          `===STRUCTURED-RESULT===` trailer on stdout for the UI runner.
#
# Three execution modes are supported. Mode selection is mutually exclusive:
#
#   restore-w3forge.sh                          interactive apply (legacy)
#   restore-w3forge.sh --dry-run [app] [db]     dry-run; zero mutation
#   restore-w3forge.sh --non-interactive        non-interactive apply
#         --app w3forge_app_<TS>.tar.gz
#         --db  w3forge_db_<TS>.sql
#         --yes-i-understand-this-replaces-production
#         [--request-id <opaque>]
#
# The non-interactive apply mode is additive - the interactive flow at the
# bottom of this file is preserved byte-for-byte (modulo the dispatch guard
# that prevents it from running when --non-interactive was passed).
#
# Strict validation in non-interactive mode (fail closed):
#   - --app and --db are required and must be basenames only (no '/',
#     no '..', no leading '-').
#   - Filenames must match the W3 Forge backup naming convention
#       ^w3forge_app_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.tar\.gz$
#       ^w3forge_db_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.sql$
#   - Resolved canonical paths must live inside the approved backup root
#     ($BACKUP_DIR = /opt/backups/w3forge). Anything outside is refused.
#   - scripts/backup-verify-w3forge.sh (or /opt/w3forge-scripts/backup-verify-w3forge.sh)
#     must report success for the chosen pair before any mutation.
#   - scripts/backup-w3forge.sh (or /opt/w3forge-scripts/backup-w3forge.sh) must
#     successfully take a fresh pre-restore backup before any mutation.
#   - If any validation fails the script exits non-zero with a clear reason
#     and (when in non-interactive mode) emits a structured-result trailer
#     with status=failed and a populated reason field. NO MUTATION has
#     occurred at the point of refusal.
#
# Exit codes (non-interactive mode):
#   0   apply succeeded
#   2   missing/invalid flags or basename / arbitrary path
#   3   filename / path validation failure
#   4   backup-verify-w3forge.sh refused the chosen pair
#   5   pre-restore backup-w3forge.sh failed
#   6   apply step failed after a fresh pre-restore backup was taken
#
# The interactive mode (no flags) and the dry-run mode (--dry-run) keep their
# v0.4.x exit semantics: 0 on success, 1 on operator cancellation / "no pair
# found", non-zero on shell errors.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-log.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"
fi
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "restore"; fi

# -----------------------------------------------------------------------------
# Argument parsing.
#
# Modes are mutually exclusive. The dry-run path retains its v0.4.8 behavior
# of accepting positional <app> <db> arguments after the flag. The
# non-interactive apply mode uses long flags only.
# -----------------------------------------------------------------------------
DRY_RUN=0
NON_INTERACTIVE=0
DRY_APP=""
DRY_DB=""

NI_APP=""
NI_DB=""
NI_YES=0
NI_REQUEST_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1; shift ;;
    --non-interactive)
      NON_INTERACTIVE=1; shift ;;
    --yes-i-understand-this-replaces-production)
      NI_YES=1; shift ;;
    --app)
      if [[ $# -lt 2 ]]; then echo "--app requires a value" >&2; exit 2; fi
      NI_APP="$2"; shift 2 ;;
    --db)
      if [[ $# -lt 2 ]]; then echo "--db requires a value" >&2; exit 2; fi
      NI_DB="$2"; shift 2 ;;
    --request-id)
      if [[ $# -lt 2 ]]; then echo "--request-id requires a value" >&2; exit 2; fi
      NI_REQUEST_ID="$2"; shift 2 ;;
    --help|-h|help)
      cat <<'EOF'
Usage:
  restore-w3forge.sh                              # interactive apply (legacy)
  restore-w3forge.sh --dry-run [<app> <db>]       # dry-run (zero mutation)
  restore-w3forge.sh --non-interactive \
      --app <w3forge_app_<TS>.tar.gz> \
      --db  <w3forge_db_<TS>.sql> \
      --yes-i-understand-this-replaces-production \
      [--request-id <opaque>]                    # non-interactive apply
EOF
      exit 0 ;;
    --*)
      echo "Unknown flag: $1" >&2; exit 2 ;;
    *)
      # Positional: only honored alongside --dry-run for backwards compat.
      if   [[ -z "$DRY_APP" ]]; then DRY_APP="$1"
      elif [[ -z "$DRY_DB"  ]]; then DRY_DB="$1"
      else
        echo "Unexpected positional argument: $1" >&2; exit 2
      fi
      shift ;;
  esac
done

if [[ $DRY_RUN -eq 1 && $NON_INTERACTIVE -eq 1 ]]; then
  echo "--dry-run and --non-interactive are mutually exclusive." >&2
  exit 2
fi

APP_DIR="${W3_APP_DIR:-/opt/w3forge}"
BACKUP_DIR="${W3_BACKUPS_DIR:-/opt/backups/w3forge}"
RESTORE_DIR="${W3_BACKUPS_DIR:-/opt/backups/w3forge}/restore"
REMOTE_USER="${W3_BACKUP_REMOTE_USER:-}"
REMOTE_HOST="${W3_BACKUP_REMOTE_HOST:-}"
REMOTE_DIR="${W3_BACKUP_REMOTE_PATH:-}"
SERVICE_NAME="${W3_SERVICE_NAME:-w3forge-admin.service}"
DB_NAME="$W3_DB_NAME"
DB_USER="$W3_DB_USER"
TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
PRE_RESTORE_APP="${W3_APP_DIR}_pre_restore_${TIMESTAMP}"

# Strict naming convention for the non-interactive path (matches what
# scripts/backup-w3forge.sh produces and what scripts/backup-verify-w3forge.sh
# already understands as a paired backup).
APP_RE='^w3forge_app_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.tar\.gz$'
DB_RE='^w3forge_db_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}\.sql$'

# v0.4.8: --dry-run handler. Print the plan and exit 0 before any mutation.
if [[ $DRY_RUN -eq 1 ]]; then
  echo "=== W3 Forge Restore Script (DRY RUN) ==="
  echo "No changes will be made."
  echo

  # Resolve pair: explicit args win; otherwise newest local complete pair.
  if [[ -n "$DRY_APP" && -n "$DRY_DB" ]]; then
    APP_BACKUP="$DRY_APP"
    DB_BACKUP="$DRY_DB"
    PAIR_SOURCE="explicit-args"
  else
    RE_TOKEN='[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}'
    declare -A AMAP=() DMAP=()
    shopt -s nullglob
    for f in "$BACKUP_DIR"/w3forge_app_*.tar.gz "$BACKUP_DIR"/w3forge_db_*.sql; do
      base="$(basename "$f")"
      if   [[ "$base" =~ ^w3forge_app_(${RE_TOKEN}) ]]; then AMAP["${BASH_REMATCH[1]}"]="$f"
      elif [[ "$base" =~ ^w3forge_db_(${RE_TOKEN}) ]];  then DMAP["${BASH_REMATCH[1]}"]="$f"
      fi
    done
    shopt -u nullglob
    NEWEST=""
    for k in "${!AMAP[@]}"; do
      [[ -n "${DMAP[$k]:-}" ]] || continue
      [[ -z "$NEWEST" || "$k" > "$NEWEST" ]] && NEWEST="$k"
    done
    if [[ -z "$NEWEST" ]]; then
      echo "No complete local pair found in $BACKUP_DIR."
      echo "Provide explicit filenames: restore-w3forge.sh --dry-run <app.tar.gz> <db.sql>"
      exit 1
    fi
    APP_BACKUP="$(basename "${AMAP[$NEWEST]}")"
    DB_BACKUP="$(basename "${DMAP[$NEWEST]}")"
    PAIR_SOURCE="newest local pair ($NEWEST)"
  fi

  echo "Selected pair source: $PAIR_SOURCE"
  echo "Selected app backup:  $APP_BACKUP"
  echo "Selected db backup:   $DB_BACKUP"
  echo
  echo "Target app path:      $APP_DIR"
  echo "Pre-restore app moved to: $PRE_RESTORE_APP (if $APP_DIR exists)"
  echo "Target database:      $DB_NAME (DROPPED and RECREATED as user $DB_USER)"
  echo "Service to restart:   $SERVICE_NAME.service"
  echo "Restore staging dir:  $RESTORE_DIR"
  echo "Remote source:        $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR"
  echo
  echo "Commands that would run (none are executed in --dry-run):"
  echo "  mkdir -p $RESTORE_DIR"
  echo "  rsync -av $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/$APP_BACKUP $RESTORE_DIR/"
  echo "  rsync -av $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/$DB_BACKUP $RESTORE_DIR/"
  echo "  systemctl stop $SERVICE_NAME"
  echo "  mv $APP_DIR $PRE_RESTORE_APP   # if $APP_DIR exists"
  echo "  mkdir -p $APP_DIR"
  echo "  tar -xzf $RESTORE_DIR/$APP_BACKUP -C /"
  echo "  dropdb --if-exists -U $DB_USER $DB_NAME"
  echo "  createdb -U $DB_USER $DB_NAME"
  echo "  psql -U $DB_USER -d $DB_NAME < $RESTORE_DIR/$DB_BACKUP"
  echo "  npm install && npm run build  # in $APP_DIR"
  echo "  systemctl start $SERVICE_NAME"
  echo
  echo "=== DRY RUN COMPLETE - no changes made ==="
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 0
fi

# -----------------------------------------------------------------------------
# v0.5.24 - non-interactive apply mode.
# -----------------------------------------------------------------------------
if [[ $NON_INTERACTIVE -eq 1 ]]; then

  # Resolve sibling helpers. Prefer the same scripts/ dir, then /opt/w3forge-scripts.
  BACKUP_VERIFY_SH="$SCRIPT_DIR/backup-verify-w3forge.sh"
  if [[ ! -x "$BACKUP_VERIFY_SH" && -x "${W3_SCRIPTS_DIR}/backup-verify-w3forge.sh" ]]; then
    BACKUP_VERIFY_SH="${W3_SCRIPTS_DIR}/backup-verify-w3forge.sh"
  fi
  BACKUP_CREATE_SH="$SCRIPT_DIR/backup-w3forge.sh"
  if [[ ! -x "$BACKUP_CREATE_SH" && -x "${W3_SCRIPTS_DIR}/backup-w3forge.sh" ]]; then
    BACKUP_CREATE_SH="${W3_SCRIPTS_DIR}/backup-w3forge.sh"
  fi

  emit_trailer() {
    # Args: status reason [app_backup] [db_backup] [pre_restore_backup_path]
    #       [restored_version] [health_ok] [duration_seconds]
    local _status="$1"; local _reason="$2"
    local _app="${3:-${NI_APP}}"
    local _db="${4:-${NI_DB}}"
    local _pre="${5:-}"
    local _ver="${6:-}"
    local _health="${7:-}"
    local _dur="${8:-0}"
    echo "===STRUCTURED-RESULT==="
    echo "status=${_status}"
    echo "request_id=${NI_REQUEST_ID}"
    echo "app_backup=${_app}"
    echo "db_backup=${_db}"
    echo "pre_restore_backup_path=${_pre}"
    echo "restored_version=${_ver}"
    echo "health_ok=${_health}"
    echo "duration_seconds=${_dur}"
    echo "reason=${_reason}"
    echo "===END==="
  }

  # --- 1) flag completeness ------------------------------------------------
  MISSING=()
  [[ -n "$NI_APP" ]] || MISSING+=("--app")
  [[ -n "$NI_DB"  ]] || MISSING+=("--db")
  [[ $NI_YES -eq 1 ]] || MISSING+=("--yes-i-understand-this-replaces-production")
  if [[ ${#MISSING[@]} -gt 0 ]]; then
    REASON="Refusing non-interactive apply: missing required flag(s): ${MISSING[*]}"
    echo "$REASON" >&2
    emit_trailer "failed" "$REASON"
    exit 2
  fi

  # --- 2) basename + naming validation ------------------------------------
  validate_basename() {
    # Args: label value regex
    local label="$1"; local value="$2"; local re="$3"
    if [[ "$value" == */* || "$value" == *..* || "$value" == -* ]]; then
      echo "Refusing non-interactive apply: ${label} must be a basename (no '/', '..', or leading '-'): $value" >&2
      emit_trailer "failed" "Invalid ${label}: must be a basename, got: $value"
      exit 3
    fi
    if ! [[ "$value" =~ $re ]]; then
      echo "Refusing non-interactive apply: ${label} does not match W3 Forge backup naming convention: $value" >&2
      emit_trailer "failed" "Invalid ${label}: does not match W3 Forge backup naming convention: $value"
      exit 3
    fi
  }
  validate_basename "--app" "$NI_APP" "$APP_RE"
  validate_basename "--db"  "$NI_DB"  "$DB_RE"

  # --- 3) approved-directory containment check ----------------------------
  # The chosen filenames are interpreted as residing under $BACKUP_DIR. We
  # never accept a path-like argument; the basename check above already
  # excluded that. realpath canonicalizes any symlinks so a symlinked file
  # whose target sits outside $BACKUP_DIR is also refused.
  APP_PATH_INPUT="$BACKUP_DIR/$NI_APP"
  DB_PATH_INPUT="$BACKUP_DIR/$NI_DB"
  if [[ ! -f "$APP_PATH_INPUT" ]]; then
    REASON="App backup file not found in approved backup directory: $APP_PATH_INPUT"
    echo "$REASON" >&2
    emit_trailer "failed" "$REASON"
    exit 3
  fi
  if [[ ! -f "$DB_PATH_INPUT" ]]; then
    REASON="DB backup file not found in approved backup directory: $DB_PATH_INPUT"
    echo "$REASON" >&2
    emit_trailer "failed" "$REASON"
    exit 3
  fi
  APP_PATH_REAL="$(realpath -m "$APP_PATH_INPUT")"
  DB_PATH_REAL="$(realpath -m "$DB_PATH_INPUT")"
  BACKUP_DIR_REAL="$(realpath -m "$BACKUP_DIR")"
  if [[ "$APP_PATH_REAL" != "$BACKUP_DIR_REAL"/* ]]; then
    REASON="App backup canonical path escapes approved backup directory: $APP_PATH_REAL"
    echo "$REASON" >&2
    emit_trailer "failed" "$REASON"
    exit 3
  fi
  if [[ "$DB_PATH_REAL" != "$BACKUP_DIR_REAL"/* ]]; then
    REASON="DB backup canonical path escapes approved backup directory: $DB_PATH_REAL"
    echo "$REASON" >&2
    emit_trailer "failed" "$REASON"
    exit 3
  fi

  # --- 4) pair verification (backup-verify-w3forge.sh) ---------------------
  if [[ ! -x "$BACKUP_VERIFY_SH" ]]; then
    REASON="backup-verify-w3forge.sh not found or not executable; cannot verify pair before restore."
    echo "$REASON" >&2
    emit_trailer "failed" "$REASON"
    exit 4
  fi
  echo "[restore-w3forge] Verifying chosen backup pair via $BACKUP_VERIFY_SH ..."
  if ! "$BACKUP_VERIFY_SH" "$NI_APP" "$NI_DB" </dev/null; then
    REASON="backup-verify-w3forge.sh refused the chosen pair ($NI_APP, $NI_DB). Refusing to proceed."
    echo "$REASON" >&2
    emit_trailer "failed" "$REASON"
    exit 4
  fi
  echo "[restore-w3forge] Pair verification OK."

  # --- 5) mandatory pre-restore backup ------------------------------------
  if [[ ! -x "$BACKUP_CREATE_SH" ]]; then
    REASON="backup-w3forge.sh not found or not executable; cannot take mandatory pre-restore backup."
    echo "$REASON" >&2
    emit_trailer "failed" "$REASON"
    exit 5
  fi
  echo "[restore-w3forge] Taking mandatory pre-restore backup via $BACKUP_CREATE_SH ..."
  PRE_BACKUP_LOG="$(mktemp -t w3forge-pre-restore-backup.XXXXXX.log)"
  trap 'rm -f "$PRE_BACKUP_LOG" 2>/dev/null || true' EXIT
  if ! "$BACKUP_CREATE_SH" </dev/null > "$PRE_BACKUP_LOG" 2>&1; then
    REASON="Pre-restore backup-w3forge.sh failed. Refusing to proceed with restore."
    echo "$REASON" >&2
    cat "$PRE_BACKUP_LOG" >&2 || true
    emit_trailer "failed" "$REASON"
    exit 5
  fi
  cat "$PRE_BACKUP_LOG"
  PRE_APP_BACKUP_LINE="$(grep -E '^w3forge_app_[0-9].*\.tar\.gz' "$PRE_BACKUP_LOG" | tail -n 1 || true)"
  if [[ -z "$PRE_APP_BACKUP_LINE" ]]; then
    # Fall back to scanning for the most recent app archive on disk.
    PRE_APP_BACKUP_LINE="$(ls -1t "$BACKUP_DIR"/w3forge_app_*.tar.gz 2>/dev/null | head -n 1 || true)"
  fi
  PRE_BACKUP_PATH="${PRE_APP_BACKUP_LINE:-(unknown)}"
  echo "[restore-w3forge] Pre-restore backup recorded: $PRE_BACKUP_PATH"

  # --- 6) actual apply ----------------------------------------------------
  #
  # Fail-closed apply (v0.5.24 hardening):
  #   - Every critical restore step is invoked through run_step, which
  #     captures the step label and the command's real exit code and
  #     short-circuits do_apply on the first failure.
  #   - do_apply itself runs under `set +e` (because the outer caller may not
  #     want a bare `set -e` to abort the trailer-emitting path), so we MUST
  #     NOT rely on -e inside do_apply. Every step is explicitly checked.
  #   - The final line of do_apply is the success marker, not a `|| true`
  #     diagnostic call. `systemctl status` is moved to a diagnostic-only
  #     call BEFORE the success marker so a failing status cannot fake
  #     success and a successful status cannot mask an earlier failure.
  #   - On any failure, FAILED_STEP carries the human label of the step that
  #     failed; the outer block emits a structured `failed` trailer that
  #     includes the pre-restore backup path and the preserved
  #     /opt/w3forge_pre_restore_<TS> path so the operator can roll back.
  START_TS="$(date +%s)"
  FAILED_STEP=""

  run_step() {
    # Args: <label> <cmd> [args...]
    #
    # IMPORTANT: We deliberately do NOT use `if ! "$@"; then` here because
    # under that form `$?` inside the branch reflects the exit status of the
    # `!` expression (always 0), not the real command's exit code. Capture
    # $? immediately after running the command, then branch on it.
    local label="$1"; shift
    echo "[restore-w3forge] step: $label ..."
    "$@"
    local rc=$?
    if [[ $rc -ne 0 ]]; then
      FAILED_STEP="$label"
      echo "[restore-w3forge] step FAILED: $label (rc=$rc)" >&2
      return $rc
    fi
    return 0
  }

  do_apply() {
    # Stage the verified pair into the restore working directory exactly
    # the way the interactive path does. Every step below is guarded -
    # the first failure short-circuits do_apply with a non-zero return
    # code and FAILED_STEP set to a human-readable label.
    run_step "mkdir restore dir"           mkdir -p "$RESTORE_DIR"                                       || return 1
    run_step "stage app archive"           cp -f "$APP_PATH_REAL" "$RESTORE_DIR/"                       || return 1
    run_step "stage db dump"               cp -f "$DB_PATH_REAL"  "$RESTORE_DIR/"                       || return 1

    run_step "systemctl stop $SERVICE_NAME" systemctl stop "$SERVICE_NAME"                              || return 1

    if [[ -d "$APP_DIR" ]]; then
      run_step "archive current /opt/w3forge to $PRE_RESTORE_APP" mv "$APP_DIR" "$PRE_RESTORE_APP"        || return 1
    fi
    run_step "mkdir /opt/w3forge"           mkdir -p "$APP_DIR"                                          || return 1
    run_step "extract app archive"         w3forge_extract_backup "$RESTORE_DIR/$NI_APP" "$APP_DIR"                         || return 1

    run_step "dropdb $DB_NAME"             dropdb --if-exists -U "$DB_USER" "$DB_NAME"                  || return 1
    run_step "createdb $DB_NAME"           createdb -U "$DB_USER" "$DB_NAME"                            || return 1
    # psql restore is gated on its own exit code; we use a bash function so
    # the redirection happens inside the guarded call.
    _psql_restore() { psql -U "$DB_USER" -d "$DB_NAME" < "$RESTORE_DIR/$NI_DB"; }
    run_step "psql restore $DB_NAME"       _psql_restore                                                || return 1

    run_step "chown /opt/w3forge"           chown -R root:root "$APP_DIR"                                || return 1
    # chmod is best-effort and diagnostic only - failures here are not a
    # restore failure (a missing scripts/ dir is fine on minimal builds).
    find "$APP_DIR/scripts" -type f -name '*.sh' -exec chmod +x {} \; 2>/dev/null || true

    # cd is checked: if it fails, npm install would run from the wrong dir
    # and silently produce a useless build.
    run_step "cd $APP_DIR"                 cd "$APP_DIR"                                                || return 1
    run_step "npm install"                 npm install                                                  || return 1
    run_step "npm run build"               npm run build                                                || return 1

    run_step "systemctl start $SERVICE_NAME" systemctl start "$SERVICE_NAME"                            || return 1

    # Diagnostic-only status print. We must NOT let its exit code influence
    # do_apply's return code, so we eat it AND we do not place it as the
    # final statement that would otherwise leak its rc to the caller.
    systemctl status "$SERVICE_NAME" --no-pager -l 2>&1 || true

    # Final explicit success marker - do_apply only returns 0 if we reach
    # this line, which is only reachable if every guarded step above
    # succeeded. Do NOT add any post-success command after this line.
    return 0
  }

  set +e
  do_apply
  APPLY_RC=$?
  set -e
  if [[ $APPLY_RC -ne 0 ]]; then
    DURATION=$(( $(date +%s) - START_TS ))
    REASON="restore apply step failed (rc=${APPLY_RC}; failed_step=${FAILED_STEP:-unknown}). Pre-restore backup is intact at ${PRE_BACKUP_PATH}; previous /opt/w3forge (if any) is preserved at ${PRE_RESTORE_APP}. Roll back by stopping the service, restoring ${PRE_RESTORE_APP} to ${APP_DIR}, and restoring the database from ${PRE_BACKUP_PATH}."
    echo "$REASON" >&2
    emit_trailer "failed" "$REASON" "" "" "$PRE_BACKUP_PATH" "" "" "$DURATION"
    exit 6
  fi

  # --- 7) post-restore health + version probes ----------------------------
  #
  # Per the v0.5.24 brief, the restore is only considered successful if
  # BOTH /health and /version respond. Probe failure is a fail-closed
  # condition; we emit a structured `failed` trailer and exit non-zero so
  # the wrapper, the route handler, and the audit log all see the
  # post-restore failure. The pre-restore backup and the preserved
  # /opt/w3forge_pre_restore_<TS> path remain on disk for rollback.
  if ! command -v curl >/dev/null 2>&1; then
    DURATION=$(( $(date +%s) - START_TS ))
    REASON="Post-restore health/version probe cannot run: curl not installed on host. Pre-restore backup is intact at ${PRE_BACKUP_PATH}; previous /opt/w3forge is preserved at ${PRE_RESTORE_APP}."
    echo "$REASON" >&2
    emit_trailer "failed" "$REASON" "$NI_APP" "$NI_DB" "$PRE_BACKUP_PATH" "" "false" "$DURATION"
    exit 6
  fi

  HEALTH_OUT="$(curl -fsS --max-time 10 "$W3_HEALTH_URL" 2>/dev/null || echo '')"
  HEALTH_OK="false"
  if [[ -n "$HEALTH_OUT" ]]; then HEALTH_OK="true"; fi

  VERSION_OUT="$(curl -fsS --max-time 10 "$W3_VERSION_URL" 2>/dev/null || echo '')"
  VERSION_OK="false"
  if [[ -n "$VERSION_OUT" ]]; then VERSION_OK="true"; fi

  RESTORED_VERSION=""
  if [[ -n "$VERSION_OUT" ]]; then
    # Best-effort extraction: tolerate either {"version":"x.y.z"} or plain text.
    RESTORED_VERSION="$(printf '%s' "$VERSION_OUT" | sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n 1)"
    if [[ -z "$RESTORED_VERSION" ]]; then
      RESTORED_VERSION="$(printf '%s' "$VERSION_OUT" | head -c 64 | tr -d '\n')"
    fi
  fi
  DURATION=$(( $(date +%s) - START_TS ))

  if [[ "$HEALTH_OK" != "true" || "$VERSION_OK" != "true" ]]; then
    REASON="Post-restore probe failed (health_ok=${HEALTH_OK}, version_ok=${VERSION_OK}). Service may not be serving traffic. Pre-restore backup is intact at ${PRE_BACKUP_PATH}; previous /opt/w3forge is preserved at ${PRE_RESTORE_APP}."
    echo "$REASON" >&2
    emit_trailer "failed" "$REASON" "$NI_APP" "$NI_DB" "$PRE_BACKUP_PATH" "$RESTORED_VERSION" "$HEALTH_OK" "$DURATION"
    exit 6
  fi

  echo "=== Restore Complete (non-interactive) ==="
  emit_trailer "success" \
    "Restore From Backup completed. App backup ${NI_APP} and DB backup ${NI_DB} applied. Pre-restore backup retained at ${PRE_BACKUP_PATH}; previous /opt/w3forge preserved at ${PRE_RESTORE_APP}." \
    "$NI_APP" "$NI_DB" "$PRE_BACKUP_PATH" "$RESTORED_VERSION" "$HEALTH_OK" "$DURATION"

  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 0
fi

# -----------------------------------------------------------------------------
# Interactive mode (legacy v0.4.x behavior - preserved unchanged).
# -----------------------------------------------------------------------------
[[ -n "$REMOTE_HOST" ]] || { echo "[BLOCKED] Interactive remote restore requires a configured Forge backup destination; use the confirmed local restore workflow instead." >&2; exit 3; }
echo "=== W3 Forge Restore Script ==="
echo "This will replace the current app and database."
echo "Restore matching app and database timestamps."
echo
ssh "$REMOTE_USER@$REMOTE_HOST" "ls -lh '$REMOTE_DIR' | grep -E 'w3forge_app_.*tar.gz|w3forge_db_.*sql' || true"
echo
read -r -p "Enter APP backup filename: " APP_BACKUP
read -r -p "Enter DB backup filename: " DB_BACKUP

echo
echo "Selected app backup: $APP_BACKUP"
echo "Selected db backup:  $DB_BACKUP"
read -r -p "Type RESTORE to continue: " CONFIRM
[[ "$CONFIRM" == "RESTORE" ]] || { echo "Restore cancelled."; exit 1; }

mkdir -p "$RESTORE_DIR"
rsync -av "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/$APP_BACKUP" "$RESTORE_DIR/"
rsync -av "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/$DB_BACKUP" "$RESTORE_DIR/"

systemctl stop "$SERVICE_NAME"
if [[ -d "$APP_DIR" ]]; then
  mv "$APP_DIR" "$PRE_RESTORE_APP"
fi
mkdir -p "$APP_DIR"
w3forge_extract_backup "$RESTORE_DIR/$APP_BACKUP" "$APP_DIR"

dropdb --if-exists -U "$DB_USER" "$DB_NAME"
createdb -U "$DB_USER" "$DB_NAME"
psql -U "$DB_USER" -d "$DB_NAME" < "$RESTORE_DIR/$DB_BACKUP"

chown -R root:root "$APP_DIR"
find "$APP_DIR/scripts" -type f -name '*.sh' -exec chmod +x {} \; || true

cd "$APP_DIR"
npm install
npm run build

systemctl start "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager -l
curl "$W3_HEALTH_URL"
curl "$W3_VERSION_URL"

echo "=== Restore Complete ==="

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
