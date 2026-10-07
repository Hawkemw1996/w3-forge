#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# package-verify-w3forge.sh
#
# Read-only pre-flight verifier for a W3 Forge release package. Runs the
# same structural checks that deploy-w3forge.sh runs internally, but never
# deploys, never installs, never moves the package, and never touches
# /opt/w3forge or /opt/w3forge-deploy.
#
# Usage:
#   package-verify-w3forge.sh                          Verify newest .tar.gz in /opt/w3forge-update-packages (legacy)
#   package-verify-w3forge.sh <path-to-package.tar.gz> Verify a specific package by absolute path
#   package-verify-w3forge.sh --channel <dev|main|installed> --version vX.Y.Z
#                                                    v0.5.38: resolve via canonical channel/version layout
#   package-verify-w3forge.sh help
#
# Checks performed (each exits non-zero on failure):
#   1. File exists, is a non-empty .tar.gz
#   2. Top-level entries all under w3forge/ (single inner root folder)
#   3. Forbidden paths absent: node_modules/, .git/, .env, backend/dist/, frontend/admin/dist/
#   4. Repo shape: VERSION, package.json, backend/, frontend/, database/, scripts/
#   5. Version alignment: VERSION == package.json == backend/package.json == frontend/admin/package.json
#   6. bash -n on every scripts/*.sh
#   7. Reports embedded version vs. currently-running /version (informational only)
#
# Extracts to /tmp/w3forge-verify.<pid>/ and removes it on exit.
# Logs to /opt/logs/w3forge/package/.
#
# v0.5.38: NO verification check is weakened. New flags only change
# how the package PATH is resolved before the existing 7-check pipeline
# is run. Check 2 (single inner root w3forge/) remains strict.

set -euo pipefail

# --- Logging ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-log.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"
fi
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "package"; fi

# Source pipeline-common for pp_resolve_package_path / pp_validate_channel /
# PP_CANONICAL_PACKAGE_NAME when running --channel/--version mode.
if   [[ -f "$SCRIPT_DIR/_w3forge-pipeline-common.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-pipeline-common.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-pipeline-common.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-pipeline-common.sh"
fi

# --- Config ----------------------------------------------------------------
UPDATE_DIR="${W3_UPDATE_DIR:-/opt/w3forge-update-packages}"
VERSION_URL="${W3_VERSION_URL:-http://localhost:8765/version}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()    { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  package-verify-w3forge.sh                          Verify newest .tar.gz in /opt/w3forge-update-packages (legacy)
  package-verify-w3forge.sh <path-to-package.tar.gz> Verify a specific package by absolute path
  package-verify-w3forge.sh --channel <dev|main|installed> --version vX.Y.Z
                                                    v0.5.38 canonical resolve
  package-verify-w3forge.sh help

Exit codes:
  0   all checks pass
  1   verification failure
  2   invalid arguments

Environment overrides:
  W3_UPDATE_DIR   Override staging directory (default /opt/w3forge-update-packages)
  W3_VERSION_URL  Override version URL (default http://localhost:8765/version)
EOF
}

# Mirrors deploy-w3forge.sh: newest .tar.gz at top level of UPDATE_DIR.
find_latest_package() {
  find "$UPDATE_DIR" -maxdepth 1 -type f -name '*.tar.gz' -print0 2>/dev/null \
    | xargs -0r ls -1t 2>/dev/null \
    | head -n 1
}

read_json_version() {
  local json_file="$1"
  python3 - <<PY
import json,sys
try:
  with open("$json_file","r") as f:
    print(json.load(f).get("version","").strip())
except Exception as e:
  sys.exit(1)
PY
}

# --- Parse args ------------------------------------------------------------
CHANNEL=""
VERSION_ARG=""
PKG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    --channel) [[ $# -ge 2 ]] || { echo "--channel requires a value" >&2; exit 2; }
               CHANNEL="$2"; shift 2 ;;
    --version) [[ $# -ge 2 ]] || { echo "--version requires a value" >&2; exit 2; }
               VERSION_ARG="$2"; shift 2 ;;
    --*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *)  if [[ -n "$PKG" ]]; then echo "Unexpected extra argument: $1" >&2; exit 2; fi
        PKG="$1"; shift ;;
  esac
done

if [[ -n "$CHANNEL" || -n "$VERSION_ARG" ]]; then
  # v0.5.38 mode: resolve via channel + version. Both required together.
  [[ -n "$CHANNEL"     ]] || fail "--version requires --channel"
  [[ -n "$VERSION_ARG" ]] || fail "--channel requires --version"
  [[ -z "$PKG"         ]] || fail "Cannot combine positional package path with --channel/--version"
  if ! declare -F pp_resolve_package_path >/dev/null 2>&1; then
    fail "pipeline-common helpers not loaded; cannot use --channel/--version mode"
  fi
  pp_validate_channel "$CHANNEL"
  case "$VERSION_ARG" in
    v[0-9]*.[0-9]*.[0-9]*) : ;;
    *) fail "--version must look like vX.Y.Z (got: $VERSION_ARG)" ;;
  esac
  PKG="$(PP_UPDATE_DIR="$UPDATE_DIR" pp_resolve_package_path "$CHANNEL" "$VERSION_ARG" 2>/dev/null || true)"
  if [[ -z "$PKG" ]]; then
    fail "Package not found for channel=${CHANNEL} version=${VERSION_ARG} under ${UPDATE_DIR}"
  fi
  info "Resolved channel=${CHANNEL} version=${VERSION_ARG} -> ${PKG}"
elif [[ -z "$PKG" ]]; then
  PKG="$(find_latest_package || true)"
  if [[ -z "$PKG" ]]; then
    fail "No .tar.gz packages found in $UPDATE_DIR (pass an explicit path)"
  fi
  info "No path given; verifying newest staged package: $PKG"
fi

[[ -f "$PKG" ]] || fail "Package not found: $PKG"
[[ -s "$PKG" ]] || fail "Package is empty: $PKG"

# --- Check 1: tarball readable ---------------------------------------------
info "Check 1: tarball is readable and non-empty"
tar -tzf "$PKG" >/dev/null 2>&1 || fail "tar cannot read $PKG (not a valid .tar.gz)"
ok "tarball is readable"

# --- Check 2: single inner root --------------------------------------------
info "Check 2: single inner root folder 'w3forge/'"
ROOTS="$(tar -tzf "$PKG" | awk -F'/' 'NF>1{print $1}' | sort -u)"
if [[ "$ROOTS" != "w3forge" ]]; then
  fail "Expected single inner root 'w3forge/', found: $ROOTS"
fi
ok "single inner root is w3forge/"

# --- Check 3: forbidden paths absent ---------------------------------------
info "Check 3: forbidden paths absent"
FORBIDDEN_HITS="$(tar -tzf "$PKG" | grep -E '(^|/)node_modules/|(^|/)\.git/|(^|/)\.env$|/backend/dist/|/frontend/admin/dist/' || true)"
if [[ -n "$FORBIDDEN_HITS" ]]; then
  echo "$FORBIDDEN_HITS" | sed 's/^/    /'
  fail "Package contains forbidden paths (see above)"
fi
ok "no forbidden paths"

# --- Extract to scratch ----------------------------------------------------
TMP_DIR="$(mktemp -d -t w3forge-verify.XXXXXX)"
cleanup() { rm -rf "$TMP_DIR" 2>/dev/null || true; }
trap cleanup EXIT

info "Extracting to $TMP_DIR for structural checks"
w3forge_verify_archive "$PKG" || exit 3
tar -xzf "$PKG" -C "$TMP_DIR" || fail "Failed to extract $PKG"
ROOT="$TMP_DIR/w3forge"
[[ -d "$ROOT" ]] || fail "Expected $ROOT to exist after extract"

# --- Check 4: repo shape ---------------------------------------------------
info "Check 4: repo shape (VERSION, package.json, backend/, frontend/, database/, scripts/)"
for p in VERSION package.json; do
  [[ -f "$ROOT/$p" ]] || fail "Missing file in package: $p"
done
for d in backend frontend database scripts; do
  [[ -d "$ROOT/$d" ]] || fail "Missing directory in package: $d/"
done
ok "repo shape complete"

# --- Check 5: version alignment --------------------------------------------
info "Check 5: version alignment across VERSION + 3 package.json files"
V_FILE="$(tr -d '[:space:]' < "$ROOT/VERSION")"
V_ROOT="$(read_json_version "$ROOT/package.json" || true)"
V_BE="$(read_json_version "$ROOT/backend/package.json" || true)"
V_FE="$(read_json_version "$ROOT/frontend/admin/package.json" || true)"

[[ -n "$V_FILE" ]] || fail "VERSION file is empty"
[[ "$V_ROOT" == "$V_FILE" ]] || fail "Version mismatch: VERSION=$V_FILE root package.json=$V_ROOT"
[[ "$V_BE"   == "$V_FILE" ]] || fail "Version mismatch: VERSION=$V_FILE backend/package.json=$V_BE"
[[ "$V_FE"   == "$V_FILE" ]] || fail "Version mismatch: VERSION=$V_FILE frontend/admin/package.json=$V_FE"
ok "all four version sources equal $V_FILE"

# --- Check 6: bash -n every scripts/*.sh -----------------------------------
info "Check 6: bash -n every scripts/*.sh in the package"
shopt -s nullglob
SH_FILES=( "$ROOT"/scripts/*.sh "$ROOT"/scripts/admin/*.sh )
shopt -u nullglob
[[ ${#SH_FILES[@]} -gt 0 ]] || fail "Package has no scripts/*.sh files"
for f in "${SH_FILES[@]}"; do
  if bash -n "$f" 2>/dev/null; then
    ok "$(basename "$f") syntax OK"
  else
    bash -n "$f" || true
    fail "Syntax error in $(basename "$f")"
  fi
done

# Also syntax-check scripts/legacy/*.sh when present (v0.4.10).
# Legacy scripts are kept in the repo for historical reference but are NOT
# installed by install-server-scripts.sh. They must still parse cleanly so the
# package is internally consistent.
if [ -d "$ROOT/scripts/legacy" ]; then
  info "Check 6b: bash -n every scripts/legacy/*.sh in the package"
  shopt -s nullglob
  LEGACY_FILES=( "$ROOT"/scripts/legacy/*.sh )
  shopt -u nullglob
  if [[ ${#LEGACY_FILES[@]} -gt 0 ]]; then
    for f in "${LEGACY_FILES[@]}"; do
      if bash -n "$f" 2>/dev/null; then
        ok "legacy/$(basename "$f") syntax OK"
      else
        bash -n "$f" || true
        fail "Syntax error in legacy/$(basename "$f")"
      fi
    done
  else
    info "scripts/legacy/ present but contains no *.sh files"
  fi
fi

# --- Check 7: informational vs running app ---------------------------------
info "Check 7: informational version comparison vs running app"
if RUNNING="$(curl -fsS --max-time 5 "$VERSION_URL" 2>/dev/null)"; then
  echo "    running /version: $RUNNING"
  echo "    package VERSION:  $V_FILE"
else
  warn "could not reach $VERSION_URL (informational check skipped)"
fi

echo ""
ok "Package verification PASSED for $PKG (version $V_FILE)"

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
