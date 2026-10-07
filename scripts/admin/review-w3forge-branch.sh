#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
#
# review-w3forge-branch.sh
#
# W3 Core v0.5.19 — Release-candidate review tool.
#
# Pulls a dev/vX.Y.Z Perplexity branch into the local review checkout and
# runs verification WITHOUT deploying anything. Everything this script does
# is read-only with respect to production runtime, the database, and the
# stable package archive. It does NOT touch:
#   - /opt/w3forge            (production runtime)
#   - /opt/w3forge-scripts           (installed operator scripts)
#   - /opt/backups/w3forge           (backup archive)
#   - /opt/w3forge-update-packages   (release-package archive)
#   - the w3forge systemd service
#   - the production database
#
# Usage:
#   review-w3forge-branch.sh <dev/vX.Y.Z> [--checkout <path>]
#   review-w3forge-branch.sh help
#
# Required:
#   <dev/vX.Y.Z>       Exact branch name to review. Must match the strict
#                      dev/vX.Y.Z format defined by the W3 Forge workflow
#                      policy. No suffixes, feature names, or alt formats.
#
# Optional:
#   --checkout <path>  Path to the local git checkout to use as the working
#                      tree. Default: /opt/w3forge-review (created if missing).
#                      The checkout MUST be a clone of the W3 Forge repo. The
#                      script refuses to touch any directory that is not.
#
# Exit codes:
#   0  review passed (verify steps succeeded)
#   1  one or more verify steps failed (non-fatal to system)
#   2  invalid arguments / branch format
#   3  pre-flight failure (missing tooling or invalid checkout)
#
# Logs to /opt/logs/w3forge/release-candidate/.
#
# This script is terminal-only and NOT wired to the Admin Controls UI in
# v0.5.19.

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
REVIEW_DIR_DEFAULT="${W3_REVIEW_DIR:-/opt/w3forge-review}"
MAIN_BRANCH="${W3_MAIN_BRANCH:-main}"

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
  review-w3forge-branch.sh <dev/vX.Y.Z> [--checkout <path>]
  review-w3forge-branch.sh help

Validates and locally verifies a Perplexity dev/vX.Y.Z branch WITHOUT
deploying anything. Runs:
  - branch format check (must match dev/vX.Y.Z exactly)
  - git fetch + checkout + pull
  - HEAD tag check (refuses to verify a tagged commit)
  - npm install / npm run build / bash -n scripts/*.sh
  - git diff --stat main...branch
  - changed-file list
  - dependency-sensitive diff for package.json + package-lock.json

This is a terminal-only review tool. It is NOT wired to the Admin Controls
UI in v0.5.19. It never touches /opt/w3forge, /opt/w3forge-scripts, /opt/backups/w3forge,
/opt/w3forge-update-packages, the systemd service, or the database.
EOF
}

# --- Parse args ------------------------------------------------------------
BRANCH=""
CHECKOUT_DIR="$REVIEW_DIR_DEFAULT"

while [[ $# -gt 0 ]]; do
  case "$1" in
    help|-h|--help) usage; exit 0 ;;
    --checkout)
      [[ $# -ge 2 ]] || { fail "--checkout requires a path"; exit 2; }
      CHECKOUT_DIR="$2"; shift 2 ;;
    --*)
      fail "Unknown flag: $1"; usage; exit 2 ;;
    *)
      if [[ -z "$BRANCH" ]]; then BRANCH="$1"; shift
      else fail "Unexpected argument: $1"; usage; exit 2
      fi
      ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  fail "Branch argument required (expected dev/vX.Y.Z)"
  usage
  exit 2
fi

# --- Branch format gate ----------------------------------------------------
# Strict dev/vX.Y.Z. No suffixes, no feature names, no alt prefixes.
if ! [[ "$BRANCH" =~ ^dev/v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Branch '$BRANCH' does not match required format dev/vX.Y.Z"
  fail "Examples accepted: dev/v0.5.19  dev/v0.6.0"
  fail "Examples rejected: dev/v0.5.19-safe  dev-v0.5.19  feature/v0.5.19"
  exit 2
fi

# --- Pre-flight ------------------------------------------------------------
command -v git  >/dev/null 2>&1 || { fail "git not found"; exit 3; }
command -v npm  >/dev/null 2>&1 || { fail "npm not found"; exit 3; }
command -v bash >/dev/null 2>&1 || { fail "bash not found"; exit 3; }

info "branch       : $BRANCH"
info "checkout dir : $CHECKOUT_DIR"

if [[ ! -d "$CHECKOUT_DIR/.git" ]]; then
  fail "Checkout dir is not a git working tree: $CHECKOUT_DIR"
  fail "Clone the W3 Forge repo there manually before running this script."
  fail "  Example: git clone <repo-url> $CHECKOUT_DIR"
  exit 3
fi

w3forge_require_repository "$CHECKOUT_DIR"
cd "$CHECKOUT_DIR"

# Sanity-check that the checkout actually looks like W3 Forge.
if [[ ! -f VERSION || ! -f package.json || ! -d scripts ]]; then
  fail "Checkout at $CHECKOUT_DIR does not look like a W3 Forge repo"
  fail "Missing VERSION, package.json, or scripts/."
  exit 3
fi

# --- Fetch + checkout + pull ----------------------------------------------
FAILED_STEPS=()
record_step() { local name="$1" rc="$2"; if (( rc != 0 )); then FAILED_STEPS+=("$name"); fi; }

info "git fetch origin --prune"
git fetch origin --prune
record_step "git fetch" $?

info "git checkout $BRANCH"
git checkout "$BRANCH" 2>/dev/null
RC=$?
if (( RC != 0 )); then
  # Try to create the tracking branch from origin.
  info "Local branch missing — creating tracking branch from origin/$BRANCH"
  git checkout -B "$BRANCH" "origin/$BRANCH"
  RC=$?
fi
record_step "git checkout" "$RC"
if (( RC != 0 )); then
  fail "Could not check out $BRANCH. Does origin/$BRANCH exist?"
  exit 1
fi

info "git pull --ff-only origin $BRANCH"
git pull --ff-only origin "$BRANCH"
record_step "git pull" $?

# --- HEAD tag gate ---------------------------------------------------------
HEAD_TAGS="$(git tag --points-at HEAD || true)"
if [[ -n "$HEAD_TAGS" ]]; then
  fail "HEAD of $BRANCH carries one or more tags: $HEAD_TAGS"
  fail "Per the W3 Forge workflow policy, a tagged commit is closed for development."
  fail "Perplexity must move to the next patch version before further work."
  FAILED_STEPS+=("HEAD tag check")
else
  ok "HEAD has no tag attached"
fi

# --- Repo-shape sanity -----------------------------------------------------
REPO_VERSION="$(tr -d '[:space:]' < VERSION 2>/dev/null || echo '')"
PKG_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo '')"
info "VERSION       : ${REPO_VERSION:-<empty>}"
info "package.json  : ${PKG_VERSION:-<empty>}"
EXPECTED_VERSION="${BRANCH#dev/v}"
if [[ "$REPO_VERSION" != "$EXPECTED_VERSION" ]]; then
  warn "VERSION ($REPO_VERSION) != branch target ($EXPECTED_VERSION)"
  FAILED_STEPS+=("VERSION mismatch")
fi
if [[ "$PKG_VERSION" != "$EXPECTED_VERSION" ]]; then
  warn "package.json version ($PKG_VERSION) != branch target ($EXPECTED_VERSION)"
  FAILED_STEPS+=("package.json version mismatch")
fi

# --- npm install -----------------------------------------------------------
info "npm install --no-audit --no-fund"
npm install --no-audit --no-fund
record_step "npm install" $?

# --- npm run build ---------------------------------------------------------
info "npm run build"
npm run build
record_step "npm run build" $?

# --- bash -n scripts/*.sh --------------------------------------------------
info "bash -n scripts/*.sh"
bash -n scripts/*.sh
record_step "bash -n scripts/*.sh" $?

# --- diff summary vs main --------------------------------------------------
info "git diff --stat $MAIN_BRANCH...$BRANCH"
if git rev-parse --verify "origin/$MAIN_BRANCH" >/dev/null 2>&1; then
  git diff --stat "origin/$MAIN_BRANCH...$BRANCH" || true
  echo ""
  info "Changed file list (origin/$MAIN_BRANCH..$BRANCH):"
  git diff --name-status "origin/$MAIN_BRANCH...$BRANCH" || true
  echo ""
  info "Dependency-sensitive diff (package*.json):"
  git diff "origin/$MAIN_BRANCH...$BRANCH" -- package.json package-lock.json \
    backend/package.json frontend/admin/package.json 2>/dev/null | head -200 || true
else
  warn "origin/$MAIN_BRANCH not found; skipping diff summary"
fi

# --- Summary ---------------------------------------------------------------
echo ""
echo "=============================="
echo " review-w3forge-branch summary"
echo "=============================="
echo " branch       : $BRANCH"
echo " checkout     : $CHECKOUT_DIR"
echo " HEAD commit  : $(git rev-parse HEAD 2>/dev/null || echo '<unknown>')"
echo " HEAD tag(s)  : ${HEAD_TAGS:-<none>}"
echo " VERSION      : ${REPO_VERSION:-<empty>}"
echo " pkg version  : ${PKG_VERSION:-<empty>}"
if (( ${#FAILED_STEPS[@]} == 0 )); then
  ok "All review steps passed"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 0
else
  fail "Failed steps: ${FAILED_STEPS[*]}"
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi
