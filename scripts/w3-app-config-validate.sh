#!/usr/bin/env bash
#
# w3-app-config-validate.sh
#
# Validates an app config under $W3_FORGE_ROOT/config/apps/<app_id>.yml.
# Part of the W3 Forge v0.1.1 modular app-admin hardening.
#
# Usage:
#   w3-app-config-validate.sh --app <app_id>
#
# Behavior:
#   ERROR  - missing config file
#   ERROR  - missing or empty required fields
#   WARN   - workspace path does not yet exist on disk
#   ERROR  - workspace path exists but is not a git repo
#   OK     - workspace exists and is a valid git repo
#
# Exits nonzero on any ERROR.
#
set -euo pipefail

W3_FORGE_ROOT="${W3_FORGE_ROOT:-/opt/w3forge-deploy}"

APP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP="${2:-}"
      shift 2
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

echo "W3 App Config Validate"
echo "======================"
echo "App: $APP"
echo "Config: $CONFIG"
echo

ERRORS=0
WARNINGS=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# top_level_value <key>
#   Returns the value of a top-level scalar key like `app_id:` or `name:`.
top_level_value() {
  local key="$1"
  awk -v key="$key" '
    # Only match keys with no leading whitespace (top level).
    $0 ~ "^"key":" {
      sub("^"key":[ \t]*", "")
      gsub(/^["'\'']|["'\'']$/, "")
      print
      exit
    }
  ' "$CONFIG"
}

# section_value <section> <key>
#   Returns the value of a nested scalar under `<section>:` such as
#   paths.workspaces or authority.may_deploy. Section-aware: stops scanning
#   when a new top-level key is encountered.
section_value() {
  local section="$1"
  local key="$2"
  awk -v section="$section" -v key="$key" '
    $0 == section ":" { inside=1; next }
    # A new top-level key (no leading whitespace, ends with ":") closes the section.
    inside && /^[^ \t#]/ { inside=0 }
    inside {
      # Match `  key: value` lines inside the section.
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

require_top_level() {
  local key="$1"
  local val
  val="$(top_level_value "$key")"
  if [[ -z "$val" ]]; then
    echo "ERROR: Missing or empty required field: $key"
    ERRORS=$((ERRORS + 1))
    return 1
  fi
  echo "OK:    $key = $val"
  return 0
}

require_nested() {
  local section="$1"
  local key="$2"
  local val
  val="$(section_value "$section" "$key")"
  if [[ -z "$val" ]]; then
    echo "ERROR: Missing or empty required field: ${section}.${key}"
    ERRORS=$((ERRORS + 1))
    return 1
  fi
  echo "OK:    ${section}.${key} = $val"
  return 0
}

# ---------------------------------------------------------------------------
# Required field checks
# ---------------------------------------------------------------------------

echo "Required fields"
echo "---------------"

require_top_level app_id || true
require_top_level name   || true

require_nested repo allowed_branch_pattern || true

require_nested paths deploy     || true
require_nested paths runtime    || true
require_nested paths workspaces || true
require_nested paths scripts    || true
require_nested paths logs       || true
require_nested paths backups    || true

require_nested authority may_deploy                 || true
require_nested authority may_tag_release            || true
require_nested authority may_modify_production_data || true

echo

# ---------------------------------------------------------------------------
# Workspace validation
# ---------------------------------------------------------------------------

echo "Workspace"
echo "---------"

WORKSPACE="$(section_value paths workspaces)"

if [[ -z "$WORKSPACE" ]]; then
  echo "ERROR: paths.workspaces is empty; cannot validate workspace."
  ERRORS=$((ERRORS + 1))
else
  if [[ ! -e "$WORKSPACE" ]]; then
    echo "WARN:  Workspace path does not yet exist: $WORKSPACE"
    WARNINGS=$((WARNINGS + 1))
  elif [[ ! -d "$WORKSPACE" ]]; then
    echo "ERROR: Workspace path exists but is not a directory: $WORKSPACE"
    ERRORS=$((ERRORS + 1))
  elif [[ ! -d "$WORKSPACE/.git" ]]; then
    echo "ERROR: Workspace exists but is not a git repo: $WORKSPACE"
    ERRORS=$((ERRORS + 1))
  else
    echo "OK:    Workspace is a valid git repo: $WORKSPACE"
  fi
fi

echo

# ---------------------------------------------------------------------------
# v0.4.0: admin_console block validation (optional section).
# ---------------------------------------------------------------------------
#
# If the admin_console section is present, validate its required fields.
# The block is optional; absence is OK (no admin UI configured).

if grep -qE '^admin_console:[[:space:]]*$' "$CONFIG"; then
  echo "Admin console"
  echo "-------------"

  ENABLED="$(section_value admin_console enabled)"
  HOST="$(section_value admin_console listen_host)"
  PORT="$(section_value admin_console listen_port)"
  AUDIT="$(section_value admin_console audit_log)"

  if [[ -z "$ENABLED" ]]; then
    echo "ERROR: admin_console.enabled is required"
    ERRORS=$((ERRORS + 1))
  else
    echo "OK:    admin_console.enabled = $ENABLED"
  fi

  if [[ -z "$HOST" ]]; then
    echo "ERROR: admin_console.listen_host is required"
    ERRORS=$((ERRORS + 1))
  else
    if [[ "$HOST" != "127.0.0.1" && "$HOST" != "localhost" && "$HOST" != "::1" ]]; then
      echo "WARN:  admin_console.listen_host=$HOST is not loopback; foundation expects 127.0.0.1"
      WARNINGS=$((WARNINGS + 1))
    else
      echo "OK:    admin_console.listen_host = $HOST"
    fi
  fi

  if [[ -z "$PORT" ]]; then
    echo "ERROR: admin_console.listen_port is required"
    ERRORS=$((ERRORS + 1))
  elif ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
    echo "ERROR: admin_console.listen_port must be numeric: $PORT"
    ERRORS=$((ERRORS + 1))
  else
    echo "OK:    admin_console.listen_port = $PORT"
  fi

  if [[ -z "$AUDIT" ]]; then
    echo "ERROR: admin_console.audit_log is required"
    ERRORS=$((ERRORS + 1))
  else
    echo "OK:    admin_console.audit_log = $AUDIT"
  fi

  # allowed_scripts must be a non-empty list. Items live in a YAML list under
  # the admin_console block. Use awk to walk the section and count list items.
  ALLOWED_COUNT="$(awk '
    $0 == "admin_console:" { inside=1; next }
    inside && /^[^ \t#]/ { inside=0 }
    inside && /^[ \t]+allowed_scripts:[ \t]*$/ { in_list=1; next }
    in_list && /^[ \t]+-[ \t]+/ { count++; next }
    in_list && /^[ \t]+[A-Za-z_]/ { in_list=0 }
    END { print count+0 }
  ' "$CONFIG")"

  if [[ "$ALLOWED_COUNT" -lt 1 ]]; then
    echo "ERROR: admin_console.allowed_scripts must list at least one script"
    ERRORS=$((ERRORS + 1))
  else
    echo "OK:    admin_console.allowed_scripts has $ALLOWED_COUNT entries"
  fi

  # Forbidden script patterns: anything that suggests deploy/release/package
  # promotion / restore is rejected here as defense-in-depth even though the
  # foundation registry would refuse them too.
  FORBIDDEN_HIT="$(awk '
    $0 == "admin_console:" { inside=1; next }
    inside && /^[^ \t#]/ { inside=0 }
    inside && /^[ \t]+allowed_scripts:[ \t]*$/ { in_list=1; next }
    in_list && /^[ \t]+-[ \t]+/ {
      line=$0
      sub(/^[ \t]+-[ \t]+/, "", line)
      if (line ~ /(deploy|release|package-(promote|install)|backup-restore|hardreset|patch-apply|prod)/) {
        print line
      }
      next
    }
    in_list && /^[ \t]+[A-Za-z_]/ { in_list=0 }
  ' "$CONFIG")"

  if [[ -n "$FORBIDDEN_HIT" ]]; then
    echo "ERROR: admin_console.allowed_scripts contains forbidden patterns:"
    echo "$FORBIDDEN_HIT" | sed 's/^/         /'
    ERRORS=$((ERRORS + 1))
  else
    echo "OK:    admin_console.allowed_scripts contains no forbidden patterns"
  fi

  echo
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo "Summary"
echo "-------"
echo "Errors:   $ERRORS"
echo "Warnings: $WARNINGS"

if (( ERRORS > 0 )); then
  exit 1
fi

exit 0
