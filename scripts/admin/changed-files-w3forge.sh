#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
set -uo pipefail

# changed-files-w3forge.sh
#
# Read-only inspector for the /opt/w3forge-deploy git working tree.
# Shows committed-since-ref changes and working-tree-only changes.
# Never modifies, never deletes, never commits.
#
# Usage:
#   changed-files-w3forge.sh
#   changed-files-w3forge.sh --since v0.4.11
#   changed-files-w3forge.sh --since <sha>
#   changed-files-w3forge.sh --stat
#   changed-files-w3forge.sh --names
#   changed-files-w3forge.sh --summary
#   changed-files-w3forge.sh --target /opt/w3forge-deploy
#   changed-files-w3forge.sh --json
#
# Exit codes:
#   0  success (even when there are no changes)
#   1  target is not a git repo
#   2  --target outside /opt/w3forge-deploy
#
# Logging: /opt/logs/w3forge/patch/changed-files-w3forge_<ts>.log
# Introduced: v0.4.12

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/_w3forge-log.sh"
elif [[ -f "${W3_SCRIPTS_DIR}/_w3forge-log.sh" ]]; then
  # shellcheck disable=SC1091
  . "${W3_SCRIPTS_DIR}/_w3forge-log.sh"
fi
# w3log_init is deferred to after argparse so --json can skip it (the
# `[w3log] ...` banner would otherwise contaminate the JSON document).

# --- defaults ---------------------------------------------------------------
TARGET="${W3_DEPLOY_DIR:-/opt/w3forge-deploy}"
SINCE=""             # empty = latest tag
VIEW="full"          # full | stat | names | summary
JSON_OUT=0

usage() {
  cat <<'EOF'
changed-files-w3forge.sh — Inspect changes in /opt/w3forge-deploy.

Usage:
  changed-files-w3forge.sh [options]

Options:
  --since <ref>     Compare against <ref> (tag or commit). Default: latest tag.
  --stat            Only show diff --stat sections.
  --names           Only show diff --name-status sections.
  --summary         One-line summary per section.
  --target <dir>    Override target (must be /opt/w3forge-deploy).
  --json            Emit machine-readable JSON summary in addition to text.
  -h, --help        Show this help.
EOF
}

# --- argparse ---------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --since)
      [[ $# -ge 2 ]] || { echo "error: --since requires a value" >&2; exit 1; }
      SINCE="$2"; shift 2 ;;
    --stat)    VIEW="stat";    shift ;;
    --names)   VIEW="names";   shift ;;
    --summary) VIEW="summary"; shift ;;
    --target)
      [[ $# -ge 2 ]] || { echo "error: --target requires a value" >&2; exit 1; }
      TARGET="$2"; shift 2 ;;
    --json) JSON_OUT=1; shift ;;
    --) shift; break ;;
    -*) echo "error: unknown flag: $1" >&2; usage >&2; exit 1 ;;
    *)  echo "error: unexpected positional arg: $1" >&2; exit 1 ;;
  esac
done

# Initialize logging now that we know whether --json was requested.
# In --json mode, suppress the log banner and file logging on stdout so the
# JSON document is the only thing on stdout. File-side logging is also
# disabled because w3log tees stdout into the log file via process
# substitution, which would otherwise capture JSON cleanly but adds the
# banner.
if (( JSON_OUT == 1 )); then
  export W3LOG_DISABLE=1
fi
if declare -F w3log_init >/dev/null 2>&1; then w3log_init "patch"; fi

TARGET_CANON="$(readlink -f "$TARGET" 2>/dev/null || echo "$TARGET")"
ALLOWED_CANON="$(readlink -f "$W3_DEPLOY_DIR" 2>/dev/null || echo "$W3_DEPLOY_DIR")"
if [[ "$TARGET" != "$W3_DEPLOY_DIR" && "$TARGET_CANON" != "$ALLOWED_CANON" ]]; then
  echo "error: --target must be /opt/w3forge-deploy (got: $TARGET)" >&2
  exit 2
fi

if [[ ! -d "$TARGET/.git" ]]; then
  echo "error: $TARGET is not a git working tree (.git missing)" >&2
  exit 1
fi

# --- banner -----------------------------------------------------------------
BRANCH="$(git -C "$TARGET" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
HEAD_FULL="$(git -C "$TARGET" rev-parse HEAD 2>/dev/null || echo "")"
HEAD_SHORT="$(git -C "$TARGET" rev-parse --short HEAD 2>/dev/null || echo "")"

# Resolve reference: --since if set; else latest tag; else initial commit.
REF_NOTE=""
if [[ -n "$SINCE" ]]; then
  if ! git -C "$TARGET" rev-parse --verify "$SINCE" >/dev/null 2>&1; then
    echo "error: ref '$SINCE' does not resolve in $TARGET" >&2
    exit 1
  fi
  REF="$SINCE"
  REF_NOTE="(explicit --since)"
else
  REF="$(git -C "$TARGET" describe --tags --abbrev=0 2>/dev/null || true)"
  if [[ -z "$REF" ]]; then
    REF="$(git -C "$TARGET" rev-list --max-parents=0 HEAD 2>/dev/null | head -1)"
    REF_NOTE="(no tags; using initial commit)"
  else
    REF_NOTE="(latest tag)"
  fi
fi
REF_SHORT="$(git -C "$TARGET" rev-parse --short "$REF" 2>/dev/null || echo "$REF")"

AHEAD_COUNT="$(git -C "$TARGET" rev-list --count "${REF}..HEAD" 2>/dev/null || echo "?")"

# When --json is set, the script emits ONLY a JSON document on stdout (the
# textual report is suppressed). When --json is absent, the textual report is
# emitted normally. Use file descriptor 9 as the human-output channel; tie it
# to stdout in text mode and to /dev/null in JSON mode so the entire textual
# section can be left in-place without conditional wrappers around every echo.
if (( JSON_OUT == 1 )); then
  exec 9>/dev/null
else
  exec 9>&1
fi

echo "changed-files-w3forge.sh" >&9
echo "  target        : $TARGET" >&9
echo "  branch        : $BRANCH" >&9
echo "  HEAD          : $HEAD_SHORT ($HEAD_FULL)" >&9
echo "  reference     : $REF ($REF_SHORT) $REF_NOTE" >&9
echo "  ahead of ref  : $AHEAD_COUNT commit(s)" >&9
echo "  view          : $VIEW" >&9
echo "  host          : $(hostname)" >&9
echo "  timestamp     : $(date '+%Y-%m-%d %H:%M:%S %Z')" >&9

# --- Counts (computed once, reused below) -----------------------------------
# Helper: count non-empty lines in a string, robust against empty input where
# `grep -c` would exit non-zero and `|| echo 0` would append a second newline.
count_nonempty_lines() {
  local s="$1"
  if [[ -z "$s" ]]; then echo 0; return 0; fi
  printf '%s\n' "$s" | grep -cE '^.+$' || echo 0
}
count_prefix() {
  local s="$1" pfx="$2"
  if [[ -z "$s" ]]; then echo 0; return 0; fi
  printf '%s\n' "$s" | grep -cE "^${pfx}" || echo 0
}

NAME_STATUS="$(git -C "$TARGET" diff --name-status "${REF}..HEAD" 2>/dev/null || true)"
COMMIT_ADDED=$(count_prefix "$NAME_STATUS" 'A')
COMMIT_MODIFIED=$(count_prefix "$NAME_STATUS" 'M')
COMMIT_DELETED=$(count_prefix "$NAME_STATUS" 'D')
COMMIT_RENAMED=$(count_prefix "$NAME_STATUS" 'R')
COMMIT_TOTAL=$(count_nonempty_lines "$NAME_STATUS")

UNSTAGED="$(git -C "$TARGET" diff --name-only 2>/dev/null || true)"
STAGED="$(git -C "$TARGET" diff --cached --name-only 2>/dev/null || true)"
UNTRACKED="$(git -C "$TARGET" ls-files --others --exclude-standard 2>/dev/null || true)"
UNSTAGED_COUNT=$(count_nonempty_lines "$UNSTAGED")
STAGED_COUNT=$(count_nonempty_lines "$STAGED")
UNTRACKED_COUNT=$(count_nonempty_lines "$UNTRACKED")

# All human-readable report sections write to FD 9. In text mode that
# resolves to stdout; in --json mode it resolves to /dev/null so stdout
# carries only the JSON document.
{
# --- Section 1: working tree ------------------------------------------------
if [[ "$VIEW" != "summary" ]]; then
  echo ""
  echo "== Working tree: git status -sb =="
  git -C "$TARGET" status -sb 2>&1 || true
fi

# --- Section 2: committed since ref -----------------------------------------
if [[ "$VIEW" != "summary" ]]; then
  echo ""
  echo "== Committed since $REF_SHORT =="
  if [[ "$VIEW" == "stat" ]]; then
    git -C "$TARGET" diff --stat "${REF}..HEAD" 2>&1 || true
  elif [[ "$VIEW" == "names" ]]; then
    git -C "$TARGET" diff --name-status "${REF}..HEAD" 2>&1 || true
  else
    git -C "$TARGET" diff --name-status "${REF}..HEAD" 2>&1 || true
    echo ""
    git -C "$TARGET" diff --stat "${REF}..HEAD" 2>&1 || true
  fi
fi

# --- Section 3: working-tree-only -------------------------------------------
if [[ "$VIEW" != "summary" ]]; then
  echo ""
  echo "== Working-tree-only (unstaged) =="
  if [[ "$VIEW" == "stat" ]]; then
    git -C "$TARGET" diff --stat 2>&1 || true
  elif [[ "$VIEW" == "names" ]]; then
    git -C "$TARGET" diff --name-status 2>&1 || true
  else
    git -C "$TARGET" diff --name-status 2>&1 || true
    echo ""
    git -C "$TARGET" diff --stat 2>&1 || true
  fi

  echo ""
  echo "== Staged (index vs HEAD) =="
  if [[ "$VIEW" == "stat" ]]; then
    git -C "$TARGET" diff --cached --stat 2>&1 || true
  elif [[ "$VIEW" == "names" ]]; then
    git -C "$TARGET" diff --cached --name-status 2>&1 || true
  else
    git -C "$TARGET" diff --cached --name-status 2>&1 || true
    echo ""
    git -C "$TARGET" diff --cached --stat 2>&1 || true
  fi
fi

# --- Section 4: untracked files ---------------------------------------------
if [[ "$VIEW" != "summary" ]]; then
  echo ""
  echo "== Untracked files (capped at 200) =="
  if [[ -z "$UNTRACKED" ]]; then
    echo "  (none)"
  else
    echo "$UNTRACKED" | head -200
    if (( UNTRACKED_COUNT > 200 )); then
      echo "  ... and $((UNTRACKED_COUNT - 200)) more"
    fi
  fi
fi

# --- Summary ----------------------------------------------------------------
echo ""
echo "== Summary =="
echo "  Committed since $REF_SHORT  : total=$COMMIT_TOTAL  A=$COMMIT_ADDED  M=$COMMIT_MODIFIED  D=$COMMIT_DELETED  R=$COMMIT_RENAMED"
echo "  Working-tree-only          : unstaged=$UNSTAGED_COUNT  staged=$STAGED_COUNT  untracked=$UNTRACKED_COUNT"
} >&9

if (( JSON_OUT == 1 )); then
  python3 - <<PY
import json, os
out = {
  "target": "$TARGET",
  "branch": "$BRANCH",
  "head": {"short": "$HEAD_SHORT", "full": "$HEAD_FULL"},
  "ref":  {"name": "$REF", "short": "$REF_SHORT", "note": "$REF_NOTE"},
  "ahead": "$AHEAD_COUNT",
  "committed_since_ref": {
    "total": int("$COMMIT_TOTAL" or 0),
    "added": int("$COMMIT_ADDED" or 0),
    "modified": int("$COMMIT_MODIFIED" or 0),
    "deleted": int("$COMMIT_DELETED" or 0),
    "renamed": int("$COMMIT_RENAMED" or 0),
  },
  "working_tree": {
    "unstaged": int("$UNSTAGED_COUNT" or 0),
    "staged":   int("$STAGED_COUNT" or 0),
    "untracked": int("$UNTRACKED_COUNT" or 0),
  },
}
print(json.dumps(out, indent=2))
PY
fi

if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
