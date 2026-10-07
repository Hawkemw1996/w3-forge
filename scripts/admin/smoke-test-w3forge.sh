#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# smoke-test-w3forge.sh
#
# W3 Core v0.5.19 — Post-deploy smoke test for the live W3 Forge runtime.
#
# Read-only with respect to /opt/w3forge, /opt/w3forge-scripts, /opt/backups/w3forge,
# /opt/w3forge-update-packages, the systemd service (status only, never restart),
# and the production database (HTTP-only checks). It never writes to the
# filesystem outside its own log directory.
#
# Checks performed:
#   - systemctl status <service> (status only; no restart)
#   - HTTP GET /health
#   - HTTP GET /version
#   - Unauthenticated /api/admin/controls and /api/auth/me return 401;
#     /command-center and W3 Core-only API paths return 404
#       * counts.total
#       * counts.byEffectiveStatus.{UI_READY,NEEDS_WRAPPER,TERMINAL_ONLY,DISABLED}
#       * counts.byStatus is printed but not asserted by default
#   - Optional --expect-version <ver>
#   - Optional --expect-buckets UI_READY=N,NEEDS_WRAPPER=N,TERMINAL_ONLY=N,DISABLED=N
#
# Usage:
#   smoke-test-w3forge.sh [options]
#   smoke-test-w3forge.sh help
#
# Options:
#   --expect-version <ver>      Pass if /version reports this exact version.
#                               Accepts 'v0.5.19' or '0.5.19'.
#   --expect-buckets <spec>     Pass if byEffectiveStatus matches the spec.
#                               Spec format (comma-separated, any order):
#                               UI_READY=12,NEEDS_WRAPPER=2,TERMINAL_ONLY=3,DISABLED=2
#                               Buckets omitted from the spec are not asserted.
#   --base-url <url>            Override base URL (default: http://localhost:8765)
#   --service <name>            Override service name (default: w3forge)
#   --timeout <seconds>         curl --max-time (default: 5)
#
# Exit codes:
#   0  all required checks passed
#   1  one or more checks failed
#   2  invalid arguments
#   3  pre-flight failure (missing tooling)
#
# Logs to /opt/logs/w3forge/release-candidate/.
#
# This script is terminal-only and NOT wired to the Admin Controls UI in
# v0.5.19. A future read-only UI surface ("Latest smoke-test result") may
# call into this scripts output via a separate visibility-only registry
# entry; this version of W3 Forge does not include that wiring.

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
BASE_URL="${W3_BASE_URL:-http://localhost:8765}"
SERVICE_NAME="${W3_SERVICE_NAME:-w3forge-admin.service}"
TIMEOUT="${W3_CURL_TIMEOUT:-5}"
EXPECT_VERSION=""
EXPECT_BUCKETS=""

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
  smoke-test-w3forge.sh [options]
  smoke-test-w3forge.sh help

Options:
  --expect-version <ver>      Assert /version reports this exact version
                              ('v0.5.19' or '0.5.19' both accepted).
  --expect-buckets <spec>     Assert byEffectiveStatus matches.
                              Example: UI_READY=12,NEEDS_WRAPPER=2,TERMINAL_ONLY=3,DISABLED=2
                              Buckets omitted from the spec are not asserted.
  --base-url <url>            Default http://localhost:8765
  --service <name>            Default w3forge
  --timeout <seconds>         curl --max-time (default 5)

Read-only smoke test. Never restarts the service. Never writes outside its
own log file. Terminal-only — not wired to the Admin Controls UI in v0.5.19.
EOF
}

# --- Parse args ------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    --expect-version)
      [[ $# -ge 2 ]] || { fail "--expect-version requires a value"; exit 2; }
      EXPECT_VERSION="$2"; shift 2 ;;
    --expect-buckets)
      [[ $# -ge 2 ]] || { fail "--expect-buckets requires a value"; exit 2; }
      EXPECT_BUCKETS="$2"; shift 2 ;;
    --base-url)
      [[ $# -ge 2 ]] || { fail "--base-url requires a value"; exit 2; }
      BASE_URL="$2"; shift 2 ;;
    --service)
      [[ $# -ge 2 ]] || { fail "--service requires a value"; exit 2; }
      SERVICE_NAME="$2"; shift 2 ;;
    --timeout)
      [[ $# -ge 2 ]] || { fail "--timeout requires a value"; exit 2; }
      TIMEOUT="$2"; shift 2 ;;
    *)
      fail "Unknown argument: $1"; usage; exit 2 ;;
  esac
done

# Normalize --expect-version: strip leading 'v' if present.
EXPECT_VERSION_NORM="${EXPECT_VERSION#v}"

command -v curl >/dev/null 2>&1 || { fail "curl not found"; exit 3; }

# jq is optional; we fall back to grep parsing when missing.
HAVE_JQ=0
if command -v jq >/dev/null 2>&1; then HAVE_JQ=1; fi

FAILED_CHECKS=()
record_fail() { FAILED_CHECKS+=("$1"); }

# --- systemctl status (status-only) ----------------------------------------
if command -v systemctl >/dev/null 2>&1; then
  info "systemctl status $SERVICE_NAME (status only; no restart)"
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "service $SERVICE_NAME is active"
  else
    fail "service $SERVICE_NAME is NOT active"
    record_fail "systemctl is-active"
  fi
  systemctl status "$SERVICE_NAME" --no-pager 2>/dev/null | head -10 || true
else
  warn "systemctl not available; skipping service-status check"
fi

# --- /health ---------------------------------------------------------------
info "GET $BASE_URL/health"
HEALTH_BODY="$(curl -fsS --max-time "$TIMEOUT" "$BASE_URL/health" 2>/dev/null || true)"
if [[ -n "$HEALTH_BODY" ]]; then
  ok "/health: $HEALTH_BODY"
else
  fail "/health did not respond OK"
  record_fail "/health"
fi

# --- /version --------------------------------------------------------------
info "GET $BASE_URL/version"
VERSION_BODY="$(curl -fsS --max-time "$TIMEOUT" "$BASE_URL/version" 2>/dev/null || true)"
LIVE_VERSION=""
if [[ -n "$VERSION_BODY" ]]; then
  ok "/version: $VERSION_BODY"
  if (( HAVE_JQ )); then
    LIVE_VERSION="$(echo "$VERSION_BODY" | jq -r '.version // .data.version // empty' 2>/dev/null || true)"
  fi
  if [[ -z "$LIVE_VERSION" ]]; then
    # Fallback: pull the first version-shaped token from the body.
    LIVE_VERSION="$(echo "$VERSION_BODY" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  fi
  info "parsed version: ${LIVE_VERSION:-<unknown>}"
else
  fail "/version did not respond OK"
  record_fail "/version"
fi

if [[ -n "$EXPECT_VERSION" ]]; then
  if [[ "$LIVE_VERSION" == "$EXPECT_VERSION_NORM" ]]; then
    ok "version matches expected ($EXPECT_VERSION_NORM)"
  else
    fail "version mismatch: live='$LIVE_VERSION' expected='$EXPECT_VERSION_NORM'"
    record_fail "version expectation"
  fi
fi

# --- Access control and removed surfaces ----------------------------------
# W3 Forge's Admin Console API requires a signed-in W3 Core user with the
# Forge admin permission, so an unauthenticated smoke test can only prove
# that it is protected. Control counts (--expect-buckets) need a session and
# are therefore not checked here.
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$1" 2>/dev/null || echo 000; }
expect_code() {
  local path="$1" want="$2" got
  got="$(http_code "$BASE_URL$path")"
  if [[ "$got" == "$want" ]]; then ok "GET $path -> $got"; else fail "GET $path -> $got (expected $want)"; record_fail "GET $path"; fi
}
expect_code /api/admin/controls 401
expect_code /api/auth/me 401
expect_code /command-center 404
expect_code /api/entities 404
expect_code /api/relationships 404
if [[ -n "$EXPECT_BUCKETS" ]]; then
  warn "--expect-buckets is not checked: /api/admin/controls requires a signed-in Forge administrator."
fi

# --- Summary ---------------------------------------------------------------
echo ""
echo "=============================="
echo " smoke-test-w3forge summary"
echo "=============================="
echo " base-url        : $BASE_URL"
echo " service         : $SERVICE_NAME"
echo " /version        : ${LIVE_VERSION:-<unknown>}"
echo " expected version: ${EXPECT_VERSION_NORM:-<not asserted>}"
echo " buckets (live)  : <not checked: needs an admin session>"
echo " expected buckets: ${EXPECT_BUCKETS:-<not asserted>}"
echo ""

if (( ${#FAILED_CHECKS[@]} == 0 )); then
  ok "All smoke-test checks passed"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 0
else
  fail "Failed checks: ${FAILED_CHECKS[*]}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi
