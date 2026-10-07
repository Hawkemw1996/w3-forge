#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
set -uo pipefail

# patch-apply-w3forge.sh
#
# Operator-invoked, dry-run-by-default applicator for a unified git patch.
# Wraps `git apply` in pre-checks, typed confirmation, and post-apply
# validation. Only ever targets /opt/w3forge-deploy. Never touches /opt/w3forge
# (runtime) or /opt/w3forge-scripts (installed admin scripts). Never auto-commits,
# auto-tags, auto-deploys, or restarts the service.
#
# Usage:
#   patch-apply-w3forge.sh <patch-file>                # default --dry-run
#   patch-apply-w3forge.sh <patch-file> --dry-run
#   patch-apply-w3forge.sh <patch-file> --apply
#   patch-apply-w3forge.sh <patch-file> --apply --allow-migrations
#   patch-apply-w3forge.sh <patch-file> --apply --allow-schema
#   patch-apply-w3forge.sh <patch-file> --apply --allow-dirty
#   patch-apply-w3forge.sh <patch-file> --target /opt/w3forge-deploy
#
# Exit codes:
#   0  dry-run success, or apply + validation completed (warnings allowed)
#   1  usage error or PATCH confirmation failure
#   2  verify policy violation (propagated from patch-verify)
#   3  verify git-apply-check failed (propagated from patch-verify)
#   4  runtime git apply failed after PATCH confirmation
#   5  dirty working tree refused (no --allow-dirty)
#
# Logging:
#   /opt/logs/w3forge/patch/patch-apply-w3forge_<ts>.log
#   /opt/logs/w3forge/patch/snapshots/<ts>_<patchbasename>.pre
#
# Introduced: v0.4.12

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-log.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"
fi
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "patch"; fi

trap 'echo "aborted (signal)"; exit 130' INT TERM

# --- defaults ---------------------------------------------------------------
PATCH_FILE=""
TARGET="${W3_DEPLOY_DIR:-/opt/w3forge-deploy}"
MODE="dry-run"     # dry-run | apply
ALLOW_MIGRATIONS=0
ALLOW_SCHEMA=0
ALLOW_DIRTY=0

usage() {
  cat <<'EOF'
patch-apply-w3forge.sh — Apply a verified unified git patch to /opt/w3forge-deploy.

Usage:
  patch-apply-w3forge.sh <patch-file> [options]

Modes:
  --dry-run               No changes (default).
  --apply                 Actually apply after PATCH confirmation.

Options:
  --target <dir>          Must be /opt/w3forge-deploy.
  --allow-migrations      Permit database/migrations/ changes.
  --allow-schema          Permit database/schema.sql changes.
  --allow-dirty           Permit applying onto a dirty working tree.

Exit codes:
  0  dry-run OK, or apply + validation completed
  1  usage error or confirmation failed
  2  verify policy violation
  3  verify git-apply-check failed
  4  git apply failed at runtime
  5  dirty working tree without --allow-dirty
EOF
}

# --- argparse ---------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) MODE="dry-run"; shift ;;
    --apply)   MODE="apply";   shift ;;
    --target)
      [[ $# -ge 2 ]] || { echo "error: --target requires a value" >&2; exit 1; }
      TARGET="$2"; shift 2 ;;
    --allow-migrations) ALLOW_MIGRATIONS=1; shift ;;
    --allow-schema)     ALLOW_SCHEMA=1;     shift ;;
    --allow-dirty)      ALLOW_DIRTY=1;      shift ;;
    --) shift; break ;;
    -*) echo "error: unknown flag: $1" >&2; usage >&2; exit 1 ;;
    *)
      if [[ -z "$PATCH_FILE" ]]; then PATCH_FILE="$1"
      else echo "error: unexpected positional arg: $1" >&2; exit 1
      fi
      shift ;;
  esac
done

if [[ -z "$PATCH_FILE" ]]; then
  echo "error: patch file is required" >&2
  usage >&2
  exit 1
fi

# Hard target lock. Patches NEVER touch /opt/w3forge (runtime) or /opt/w3forge-scripts.
TARGET_CANON="$(readlink -f "$TARGET" 2>/dev/null || echo "$TARGET")"
ALLOWED_CANON="$(readlink -f "$W3_DEPLOY_DIR" 2>/dev/null || echo "$W3_DEPLOY_DIR")"
case "$TARGET_CANON" in
  /opt/w3forge|/opt/w3forge/*)
    echo "error: --target points at runtime /opt/w3forge; patches never touch the runtime tree" >&2
    exit 1 ;;
  /opt/w3forge-scripts|/opt/w3forge-scripts/*)
    echo "error: --target points at /opt/w3forge-scripts; patches never touch installed admin scripts" >&2
    exit 1 ;;
esac
if [[ "$TARGET" != "$W3_DEPLOY_DIR" && "$TARGET_CANON" != "$ALLOWED_CANON" ]]; then
  echo "error: --target must be /opt/w3forge-deploy (got: $TARGET)" >&2
  exit 1
fi

# --- banner -----------------------------------------------------------------
echo "patch-apply-w3forge.sh"
echo "  patch         : $PATCH_FILE"
echo "  target        : $TARGET"
echo "  mode          : $MODE"
echo "  allow-migr.   : $ALLOW_MIGRATIONS"
echo "  allow-schema  : $ALLOW_SCHEMA"
echo "  allow-dirty   : $ALLOW_DIRTY"
echo "  host          : $(hostname)"
echo "  timestamp     : $(date '+%Y-%m-%d %H:%M:%S %Z')"

# Locate patch-verify (sibling on dev, /opt/w3forge-scripts on prod)
VERIFY_BIN=""
if [[ -x "$SCRIPT_DIR/patch-verify-w3forge.sh" ]]; then
  VERIFY_BIN="$SCRIPT_DIR/patch-verify-w3forge.sh"
elif [[ -x "${W3_SCRIPTS_DIR}/patch-verify-w3forge.sh" ]]; then
  VERIFY_BIN="${W3_SCRIPTS_DIR}/patch-verify-w3forge.sh"
else
  echo "error: cannot find patch-verify-w3forge.sh next to this script or in /opt/w3forge-scripts" >&2
  exit 1
fi

# Locate status (informational pre-flight only)
STATUS_BIN=""
if [[ -x "${W3_SCRIPTS_DIR}/status-w3forge.sh" ]]; then STATUS_BIN="${W3_SCRIPTS_DIR}/status-w3forge.sh"
elif [[ -x "$SCRIPT_DIR/status-w3forge.sh" ]]; then STATUS_BIN="$SCRIPT_DIR/status-w3forge.sh"
fi
DOCTOR_BIN=""
if [[ -x "${W3_SCRIPTS_DIR}/doctor-w3forge.sh" ]]; then DOCTOR_BIN="${W3_SCRIPTS_DIR}/doctor-w3forge.sh"
elif [[ -x "$SCRIPT_DIR/doctor-w3forge.sh" ]]; then DOCTOR_BIN="$SCRIPT_DIR/doctor-w3forge.sh"
fi

# --- Run patch-verify first -------------------------------------------------
echo ""
echo "== Step 1: patch-verify =="
VERIFY_ARGS=("$PATCH_FILE" "--target" "$TARGET")
(( ALLOW_MIGRATIONS == 1 )) && VERIFY_ARGS+=("--allow-migrations")
(( ALLOW_SCHEMA == 1 ))     && VERIFY_ARGS+=("--allow-schema")
"$VERIFY_BIN" "${VERIFY_ARGS[@]}"
VRC=$?
if (( VRC != 0 )); then
  echo ""
  echo "patch-verify failed with exit code $VRC; refusing to apply."
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit "$VRC"
fi

# --- Pre-flight: target git working tree ------------------------------------
echo ""
echo "== Step 2: target working-tree check =="
if [[ ! -d "$TARGET/.git" ]]; then
  echo "error: $TARGET is not a git working tree (.git missing)" >&2
  exit 1
fi
PORC="$(git -C "$TARGET" status --porcelain 2>/dev/null || true)"
if [[ -n "$PORC" ]]; then
  if (( ALLOW_DIRTY == 1 )); then
    echo "WARN: working tree has uncommitted changes; continuing under --allow-dirty:"
    while IFS= read -r line; do echo "  $line"; done <<<"$PORC"
  else
    echo "error: working tree at $TARGET has uncommitted changes; refuse to apply." >&2
    echo "       pass --allow-dirty to override (the snapshot will capture the dirty state)." >&2
    while IFS= read -r line; do echo "  $line" >&2; done <<<"$PORC"
    if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
    exit 5
  fi
else
  echo "OK: working tree clean"
fi

# --- Status snapshot (informational) ----------------------------------------
echo ""
echo "== Step 3: status-w3forge.sh snapshot =="
if [[ -n "$STATUS_BIN" ]]; then
  STATUS_OUT="$("$STATUS_BIN" 2>&1 || true)"
  STATUS_RC=$?
  echo "$STATUS_OUT" | tail -30
  echo "(status exit code captured: $STATUS_RC; informational only)"
else
  echo "WARN: status-w3forge.sh not available; skipping"
fi

# --- Pre-patch snapshot -----------------------------------------------------
SNAP_TS="$(date -u '+%Y-%m-%dT%H-%M-%SZ')"
SNAP_DIR="${W3LOG_ROOT:-/opt/logs/w3forge}/patch/snapshots"
mkdir -p "$SNAP_DIR" 2>/dev/null || true
PATCH_BASE="$(basename "$PATCH_FILE")"
SNAP_FILE="$SNAP_DIR/${SNAP_TS}_${PATCH_BASE}.pre"

echo ""
echo "== Step 4: pre-patch snapshot =="
{
  echo "# Pre-patch snapshot — $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "# patch    : $PATCH_FILE"
  echo "# target   : $TARGET"
  echo "# mode     : $MODE"
  echo ""
  echo "## git branch"
  git -C "$TARGET" rev-parse --abbrev-ref HEAD 2>&1 || true
  echo ""
  echo "## HEAD SHA"
  git -C "$TARGET" rev-parse HEAD 2>&1 || true
  echo ""
  echo "## git status -sb"
  git -C "$TARGET" status -sb 2>&1 || true
  echo ""
  echo "## git diff (working tree vs HEAD, full)"
  git -C "$TARGET" diff 2>&1 || true
  echo ""
  echo "## git diff --cached (staged vs HEAD, full)"
  git -C "$TARGET" diff --cached 2>&1 || true
} > "$SNAP_FILE" 2>&1
if [[ -s "$SNAP_FILE" ]]; then
  echo "OK: snapshot written -> $SNAP_FILE ($(wc -c < "$SNAP_FILE") bytes)"
else
  echo "WARN: snapshot file is empty (continuing); path: $SNAP_FILE"
fi

# --- Dry-run branch ---------------------------------------------------------
if [[ "$MODE" == "dry-run" ]]; then
  echo ""
  echo "== Step 5: dry-run preview =="
  git -C "$TARGET" apply --check --stat --whitespace=nowarn "$PATCH_FILE" 2>&1 || true
  echo ""
  echo "DRY-RUN: no changes made. Re-run with --apply to execute."
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 0
fi

# --- Apply branch: typed confirmation ---------------------------------------
echo ""
echo "== Step 5: PATCH confirmation =="
echo "About to apply patch to working tree at $TARGET."
echo "This will modify files but will NOT commit, tag, deploy, or restart."
read -r -p "Type PATCH to apply: " CONFIRM
if [[ "${CONFIRM:-}" != "PATCH" ]]; then
  echo "confirmation not received; aborting apply."
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 1
fi

# --- git apply --------------------------------------------------------------
echo ""
echo "== Step 6: git apply =="
# Note: `git apply` by default does NOT touch the index (the change lands in
# the working tree only). We intentionally omit --index so the operator must
# stage/commit explicitly afterward.
APPLY_ERR="$(git -C "$TARGET" apply --whitespace=nowarn "$PATCH_FILE" 2>&1)"
APPLY_RC=$?
if (( APPLY_RC != 0 )); then
  echo "ERROR: git apply failed with exit code $APPLY_RC:" >&2
  while IFS= read -r line; do echo "  $line" >&2; done <<<"$APPLY_ERR"
  echo "" >&2
  echo "Working tree state preserved for inspection. Snapshot: $SNAP_FILE" >&2
  echo "To revert any partial changes: git -C $TARGET checkout -- ." >&2
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 4
fi
echo "OK: git apply succeeded"

# --- Post-apply summary -----------------------------------------------------
echo ""
echo "== Step 7: post-apply summary =="
echo "--- git status -sb ---"
git -C "$TARGET" status -sb 2>&1 || true
echo ""
echo "--- git diff --stat ---"
git -C "$TARGET" diff --stat 2>&1 || true

# --- Conditional post-apply validation --------------------------------------
echo ""
echo "== Step 8: post-apply validation =="

# Determine which validations to run by inspecting the patch's affected files.
FILES_TOUCHED="$(grep -oE '^\+\+\+ (b/)?[^[:space:]]+' "$PATCH_FILE" 2>/dev/null \
                  | sed -E 's|^\+\+\+ (b/)?||' \
                  | grep -v '^/dev/null$' || true)"
# Also include 'diff --git a/X b/Y' headers for renames/deletes
FILES_DIFF="$(grep -oE '^diff --git a/[^[:space:]]+ b/[^[:space:]]+' "$PATCH_FILE" 2>/dev/null \
              | awk '{print $4}' | sed 's|^b/||' || true)"
ALL_TOUCHED="$(printf '%s\n%s\n' "$FILES_TOUCHED" "$FILES_DIFF" | sort -u | grep -v '^$' || true)"

NEED_SCRIPTS=0
NEED_LEGACY=0
NEED_NPM=0
NEED_BUILD_BACKEND=0
NEED_BUILD_FRONTEND=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    scripts/legacy/*.sh)  NEED_LEGACY=1 ;;
    scripts/*.sh)         NEED_SCRIPTS=1 ;;
  esac
  case "$f" in
    package.json|package-lock.json|backend/package.json|frontend/admin/package.json)
      NEED_NPM=1 ;;
  esac
  case "$f" in
    backend/package.json) NEED_BUILD_BACKEND=1 ;;
    frontend/admin/package.json) NEED_BUILD_FRONTEND=1 ;;
  esac
done <<<"$ALL_TOUCHED"

VAL_WARNINGS=0

if (( NEED_SCRIPTS == 1 )); then
  echo "--- bash -n scripts/*.sh ---"
  for f in "$TARGET"/scripts/*.sh; do
    [[ -e "$f" ]] || continue
    if ! bash -n "$f" 2>/dev/null; then
      echo "  FAIL syntax: $f" >&2
      VAL_WARNINGS=$((VAL_WARNINGS+1))
    fi
  done
  echo "  done"
fi

if (( NEED_LEGACY == 1 )); then
  echo "--- bash -n scripts/legacy/*.sh ---"
  for f in "$TARGET"/scripts/legacy/*.sh; do
    [[ -e "$f" ]] || continue
    if ! bash -n "$f" 2>/dev/null; then
      echo "  FAIL syntax: $f" >&2
      VAL_WARNINGS=$((VAL_WARNINGS+1))
    fi
  done
  echo "  done"
fi

if (( NEED_NPM == 1 )); then
  echo "--- npm ci (root) ---"
  if ! ( cd "$TARGET" && npm ci --ignore-scripts ) >/dev/null 2>&1; then
    echo "  WARN: npm ci returned non-zero"
    VAL_WARNINGS=$((VAL_WARNINGS+1))
  else
    echo "  OK"
  fi
fi
if (( NEED_BUILD_BACKEND == 1 )); then
  echo "--- backend npm run build ---"
  if ! ( cd "$TARGET/backend" && npm run build ) >/dev/null 2>&1; then
    echo "  WARN: backend build returned non-zero"
    VAL_WARNINGS=$((VAL_WARNINGS+1))
  else
    echo "  OK"
  fi
fi
if (( NEED_BUILD_FRONTEND == 1 )); then
  echo "--- frontend npm run build ---"
  if ! ( cd "$TARGET/frontend" && npm run build ) >/dev/null 2>&1; then
    echo "  WARN: frontend build returned non-zero"
    VAL_WARNINGS=$((VAL_WARNINGS+1))
  else
    echo "  OK"
  fi
fi

echo ""
echo "--- doctor-w3forge.sh ---"
if [[ -n "$DOCTOR_BIN" ]]; then
  if "$DOCTOR_BIN" >/dev/null 2>&1; then
    echo "  PASS"
  else
    echo "  WARN: doctor returned non-zero (review manually)"
    VAL_WARNINGS=$((VAL_WARNINGS+1))
  fi
else
  echo "  WARN: doctor-w3forge.sh not available; skipping"
fi

# --- Next steps banner ------------------------------------------------------
echo ""
echo "== Next steps =="
cat <<EONS
  1. Review the diff:           git -C $TARGET diff
  2. Manually test the change in the staging tree.
  3. Inspect what changed:      /opt/w3forge-scripts/changed-files-w3forge.sh
  4. Produce an official package once the change is accepted:
        /opt/w3forge-scripts/release-current-w3forge.sh
  5. Deploy through the normal SOP:
        /opt/w3forge-scripts/package-verify-w3forge.sh /opt/w3forge-update-packages/<file>.tar.gz
        /opt/w3forge-scripts/deploy-w3forge.sh
        /opt/w3forge-scripts/doctor-w3forge.sh
        /opt/w3forge-scripts/status-w3forge.sh

  If you need to revert the patch:
        git -C $TARGET apply --reverse "$PATCH_FILE"
        (or)  git -C $TARGET checkout -- .

  Pre-patch snapshot: $SNAP_FILE
EONS

echo ""
if (( VAL_WARNINGS > 0 )); then
  echo "Patch applied with $VAL_WARNINGS validation warning(s). Review output above."
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 0
fi
echo "Patch applied cleanly. 0 warnings."
if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
