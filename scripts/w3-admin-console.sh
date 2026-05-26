#!/usr/bin/env bash
#
# w3-admin-console.sh
#
# v0.4.0 — W3 Forge Admin Interface launcher.
#
# Starts the Forge admin backend (Node/Express) and serves the built
# admin frontend on the loopback interface configured under
# admin_console.listen_host / admin_console.listen_port. The backend
# loads config/apps/<app_id>.yml via the same config-driven model the
# rest of W3 Forge uses.
#
# Refuses to run when:
#   - branch is main or master
#   - admin_console block is missing
#   - admin_console.enabled is not true
#   - backend/dist/index.js is missing (run npm run build first)
#
# Usage:
#   w3-admin-console.sh --app <app_id>
#   w3-admin-console.sh --app <app_id> --foreground   # don't background
#
# Foundation-only: no deploy / release / package / production behavior.
#
set -euo pipefail

W3_FORGE_ROOT="${W3_FORGE_ROOT:-/opt/w3forge-deploy}"

APP=""
FOREGROUND=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP="${2:-}"
      shift 2
      ;;
    --foreground)
      FOREGROUND=1
      shift
      ;;
    *)
      echo "ERROR: Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$APP" ]]; then
  echo "ERROR: Missing --app <app_id>"
  exit 1
fi

CONFIG="$W3_FORGE_ROOT/config/apps/${APP}.yml"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: App config not found: $CONFIG"
  exit 1
fi

# ---------------------------------------------------------------------------
# Branch guard — never run from main/master.
# ---------------------------------------------------------------------------

if [[ -d "$W3_FORGE_ROOT/.git" ]]; then
  BRANCH="$(git -C "$W3_FORGE_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  if [[ "$BRANCH" == "main" || "$BRANCH" == "master" ]]; then
    echo "ERROR: Refusing to start admin console from protected branch: $BRANCH"
    echo "       W3 Forge admin runs only from dev/v* branches."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Parse admin_console block.
# ---------------------------------------------------------------------------

# section_value <section> <key> — same shape as w3-app-config-validate.sh.
section_value() {
  local section="$1"
  local key="$2"
  awk -v section="$section" -v key="$key" '
    $0 == section ":" { inside=1; next }
    inside && /^[^ \t#]/ { inside=0 }
    inside {
      if (match($0, "^[ \t]+"key":")) {
        line = $0
        sub("^[ \t]+"key":[ \t]*", "", line)
        gsub(/^["'\'']|["'\'']$/, "", line)
        print line
        exit
      }
    }
  ' "$CONFIG"
}

if ! grep -qE '^admin_console:[[:space:]]*$' "$CONFIG"; then
  echo "ERROR: admin_console block is missing from $CONFIG"
  exit 1
fi

ENABLED="$(section_value admin_console enabled)"
HOST="$(section_value admin_console listen_host)"
PORT="$(section_value admin_console listen_port)"
AUDIT="$(section_value admin_console audit_log)"

if [[ "$ENABLED" != "true" ]]; then
  echo "ERROR: admin_console.enabled is not true (got: '$ENABLED')"
  exit 1
fi

if [[ -z "$HOST" || -z "$PORT" ]]; then
  echo "ERROR: admin_console.listen_host and admin_console.listen_port are required"
  exit 1
fi

# ---------------------------------------------------------------------------
# Validate config end-to-end via the existing validator.
# ---------------------------------------------------------------------------

if ! "$W3_FORGE_ROOT/scripts/w3-app-config-validate.sh" --app "$APP" >/dev/null; then
  echo "ERROR: w3-app-config-validate.sh --app $APP failed"
  exit 1
fi

# ---------------------------------------------------------------------------
# Locate backend bundle.
# ---------------------------------------------------------------------------

BACKEND_DIR="$W3_FORGE_ROOT/backend"
BACKEND_ENTRY="$BACKEND_DIR/dist/index.js"

if [[ ! -f "$BACKEND_ENTRY" ]]; then
  echo "ERROR: Backend bundle not found: $BACKEND_ENTRY"
  echo "       Run: (cd $BACKEND_DIR && npm ci && npm run build)"
  exit 1
fi

# Ensure audit log directory exists.
AUDIT_PATH="$AUDIT"
if [[ "$AUDIT_PATH" != /* ]]; then
  AUDIT_PATH="$W3_FORGE_ROOT/$AUDIT_PATH"
fi
mkdir -p "$(dirname "$AUDIT_PATH")"

echo "W3 Forge Admin Console"
echo "======================"
echo "App:          $APP"
echo "Config:       $CONFIG"
echo "Forge root:   $W3_FORGE_ROOT"
echo "Listen:       http://$HOST:$PORT"
echo "Audit log:    $AUDIT_PATH"
echo

# ---------------------------------------------------------------------------
# Launch.
# ---------------------------------------------------------------------------

export W3_FORGE_ROOT
export W3_FORGE_ACTIVE_APP="$APP"
export W3_FORGE_ADMIN_HOST="$HOST"
export W3_FORGE_ADMIN_PORT="$PORT"
export W3_FORGE_ADMIN_AUDIT="$AUDIT_PATH"

if (( FOREGROUND )); then
  exec node "$BACKEND_ENTRY"
fi

LOG_DIR="$W3_FORGE_ROOT/logs/admin"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/console.log"
nohup node "$BACKEND_ENTRY" >>"$LOG_FILE" 2>&1 &
PID=$!
echo "Started PID: $PID"
echo "Log:         $LOG_FILE"
echo "$PID" > "$LOG_DIR/console.pid"
exit 0
