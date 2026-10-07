#!/usr/bin/env bash
# App ownership and capability checks run before logging or any operation.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_w3forge-policy.sh"
w3forge_guard_script "${BASH_SOURCE[0]##*/}" "$@"
set -uo pipefail

# patch-verify-w3forge.sh
#
# Read-only policy + structural gate for a unified git diff patch file.
# Verifies the patch can be safely applied to /opt/w3forge-deploy without
# touching forbidden runtime paths, secrets, build output, or git metadata.
#
# Usage:
#   patch-verify-w3forge.sh <patch-file>
#   patch-verify-w3forge.sh <patch-file> --target /opt/w3forge-deploy
#   patch-verify-w3forge.sh <patch-file> --allow-migrations
#   patch-verify-w3forge.sh <patch-file> --allow-schema
#   patch-verify-w3forge.sh <patch-file> --json
#
# Exit codes:
#   0  patch verified safe to apply (warnings allowed)
#   1  usage error
#   2  policy violation (forbidden path, allowlist breach, missing allow flag)
#   3  git apply --check failed
#
# Logging: /opt/logs/w3forge/patch/patch-verify-w3forge_<ts>.log
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

# --- defaults ---------------------------------------------------------------
PATCH_FILE=""
TARGET="${W3_DEPLOY_DIR:-/opt/w3forge-deploy}"
ALLOW_MIGRATIONS=0
ALLOW_SCHEMA=0
JSON_OUT=0

usage() {
  cat <<'EOF'
patch-verify-w3forge.sh — Read-only verification of a unified git patch.

Usage:
  patch-verify-w3forge.sh <patch-file> [options]

Options:
  --target <dir>          Target git working tree (default /opt/w3forge-deploy;
                          must end with /opt/w3forge-deploy)
  --allow-migrations      Permit changes under database/migrations/
  --allow-schema          Permit changes to database/schema.sql
  --json                  Emit machine-readable JSON summary in addition to
                          the human report
  -h, --help              Show this help

Exit codes:
  0  patch verified safe to apply (warnings allowed)
  1  usage error
  2  policy violation
  3  git apply --check failed
EOF
}

# --- argparse ---------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --target)
      [[ $# -ge 2 ]] || { echo "error: --target requires a value" >&2; exit 1; }
      TARGET="$2"; shift 2 ;;
    --allow-migrations) ALLOW_MIGRATIONS=1; shift ;;
    --allow-schema)     ALLOW_SCHEMA=1;     shift ;;
    --json)             JSON_OUT=1;         shift ;;
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

# Refuse any --target that isn't /opt/w3forge-deploy. Patch workflow is locked
# to the staging tree by design; production runtime is never a valid target.
TARGET_CANON="$(readlink -f "$TARGET" 2>/dev/null || echo "$TARGET")"
ALLOWED_CANON="$(readlink -f "$W3_DEPLOY_DIR" 2>/dev/null || echo "$W3_DEPLOY_DIR")"
if [[ "$TARGET" != "$W3_DEPLOY_DIR" && "$TARGET_CANON" != "$ALLOWED_CANON" ]]; then
  echo "error: --target must be /opt/w3forge-deploy (got: $TARGET)" >&2
  echo "       patches never target /opt/w3forge (runtime) or any other tree." >&2
  exit 1
fi

# --- banner -----------------------------------------------------------------
echo "patch-verify-w3forge.sh"
echo "  patch       : $PATCH_FILE"
echo "  target      : $TARGET"
echo "  allow-migr. : $ALLOW_MIGRATIONS"
echo "  allow-schema: $ALLOW_SCHEMA"
echo "  host        : $(hostname)"
echo "  timestamp   : $(date '+%Y-%m-%d %H:%M:%S %Z')"

PROBLEMS=0
WARNINGS=0
FORBIDDEN_HITS=()
SENSITIVE_HITS=()
ALLOW_VIOLATIONS=()
MIGRATION_HITS=()
SCHEMA_HITS=()
TRAVERSAL_HITS=()
BINARY_FLAG=0
LOCK_ONLY_FLAG=0

# --- Check 1: file readable and non-empty -----------------------------------
echo ""
echo "Check 1: patch file readable and non-empty"
if [[ ! -e "$PATCH_FILE" ]]; then
  echo "  FAIL: $PATCH_FILE does not exist" >&2
  exit 1
fi
if [[ ! -f "$PATCH_FILE" ]]; then
  echo "  FAIL: $PATCH_FILE is not a regular file" >&2
  exit 1
fi
if [[ ! -r "$PATCH_FILE" ]]; then
  echo "  FAIL: $PATCH_FILE is not readable" >&2
  exit 1
fi
if [[ ! -s "$PATCH_FILE" ]]; then
  echo "  FAIL: $PATCH_FILE is empty" >&2
  exit 1
fi
PATCH_SIZE="$(wc -c < "$PATCH_FILE")"
PATCH_LINES="$(wc -l < "$PATCH_FILE")"
echo "  OK: $PATCH_SIZE bytes, $PATCH_LINES lines"

# --- Check 2: format detection ----------------------------------------------
echo ""
echo "Check 2: patch format"
FIRST_LINE="$(head -1 "$PATCH_FILE" 2>/dev/null || echo "")"
FORMAT="unknown"
if grep -qE '^diff --git ' "$PATCH_FILE"; then
  FORMAT="git"
elif grep -qE '^Index: ' "$PATCH_FILE" || grep -qE '^--- ' "$PATCH_FILE"; then
  FORMAT="unified"
fi
if [[ "$FIRST_LINE" == From\ * ]]; then
  echo "  FAIL: patch appears to be in mailbox (git format-patch) format; use git diff or git format-patch --stdout output without From/Subject headers" >&2
  PROBLEMS=$((PROBLEMS+1))
fi
if grep -qE '^GIT binary patch' "$PATCH_FILE"; then
  echo "  FAIL: patch contains binary hunks (GIT binary patch); refuse for safety" >&2
  PROBLEMS=$((PROBLEMS+1))
  BINARY_FLAG=1
fi
if [[ "$FORMAT" == "unknown" ]]; then
  echo "  FAIL: cannot detect a diff --git or unified diff header" >&2
  PROBLEMS=$((PROBLEMS+1))
fi
echo "  format     : $FORMAT"

if (( PROBLEMS > 0 )); then
  echo ""
  echo "verify FAILED at format gate."
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 2
fi

# --- Check 3: extract affected files ----------------------------------------
echo ""
echo "Check 3: extract affected file list"

# Parse 'diff --git a/<x> b/<y>' lines. We track the b/ side which is the
# post-state path. Also detect 'new file mode' / 'deleted file mode' /
# 'rename to' to classify status. Implemented in Python for robust parsing.
PARSED="$(python3 - "$PATCH_FILE" <<'PY'
import sys, re, os, json

path = sys.argv[1]
files = []  # list of (status, path)
cur_b = None
cur_a = None
cur_status = "M"
new_mode_seen = False
deleted_mode_seen = False
rename_to_seen = False

with open(path, "r", errors="replace") as f:
    for line in f:
        m = re.match(r'^diff --git a/(.+?) b/(.+?)\s*$', line)
        if m:
            # flush previous
            if cur_b is not None:
                status = "A" if new_mode_seen else ("D" if deleted_mode_seen else ("R" if rename_to_seen else "M"))
                files.append((status, cur_b, cur_a))
            cur_a = m.group(1)
            cur_b = m.group(2)
            cur_status = "M"
            new_mode_seen = False
            deleted_mode_seen = False
            rename_to_seen = False
            continue
        if line.startswith("new file mode"):
            new_mode_seen = True
        elif line.startswith("deleted file mode"):
            deleted_mode_seen = True
        elif line.startswith("rename to "):
            rename_to_seen = True
            cur_b = line[len("rename to "):].strip()
        elif line.startswith("rename from "):
            cur_a = line[len("rename from "):].strip()

# flush last
if cur_b is not None:
    status = "A" if new_mode_seen else ("D" if deleted_mode_seen else ("R" if rename_to_seen else "M"))
    files.append((status, cur_b, cur_a))

# Also catch unified-style patches without 'diff --git' (Index: + --- / +++)
if not files:
    cur_b = None
    cur_a = None
    with open(path, "r", errors="replace") as f:
        for line in f:
            m = re.match(r'^\+\+\+ (?:b/)?(.+?)(?:\t.*)?$', line)
            if m and m.group(1) not in ("/dev/null",):
                cur_b = m.group(1)
                continue
            m = re.match(r'^--- (?:a/)?(.+?)(?:\t.*)?$', line)
            if m:
                cur_a = m.group(1)
                continue
            if line.startswith("@@") and cur_b is not None:
                status = "M"
                if cur_a == "/dev/null":
                    status = "A"
                files.append((status, cur_b, cur_a))
                cur_b = None
                cur_a = None

# Dedup preserving order
seen = set()
out = []
for s, b, a in files:
    key = (s, b)
    if key in seen: continue
    seen.add(key)
    out.append({"status": s, "path": b, "old_path": a or ""})

print(json.dumps(out))
PY
)"

if [[ -z "$PARSED" || "$PARSED" == "[]" ]]; then
  echo "  FAIL: no affected files could be parsed from the patch" >&2
  echo ""
  echo "verify FAILED at extract gate."
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 2
fi

FILE_COUNT="$(echo "$PARSED" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d))')"
ADD_COUNT="$(echo "$PARSED" | python3 -c 'import sys,json; print(sum(1 for x in json.load(sys.stdin) if x["status"]=="A"))')"
MOD_COUNT="$(echo "$PARSED" | python3 -c 'import sys,json; print(sum(1 for x in json.load(sys.stdin) if x["status"]=="M"))')"
DEL_COUNT="$(echo "$PARSED" | python3 -c 'import sys,json; print(sum(1 for x in json.load(sys.stdin) if x["status"]=="D"))')"
REN_COUNT="$(echo "$PARSED" | python3 -c 'import sys,json; print(sum(1 for x in json.load(sys.stdin) if x["status"]=="R"))')"

echo "  files: $FILE_COUNT (added=$ADD_COUNT modified=$MOD_COUNT deleted=$DEL_COUNT renamed=$REN_COUNT)"
echo ""
echo "Affected files:"
echo "$PARSED" | python3 -c '
import sys, json
for x in json.load(sys.stdin):
    s = x["status"]
    p = x["path"]
    if s == "R":
        op = x.get("old_path") or ""
        print("  [" + s + "] " + p + "  (was " + op + ")")
    else:
        print("  [" + s + "] " + p)
'

# Pull a plain list of post-paths
FILE_LIST="$(echo "$PARSED" | python3 -c 'import sys,json
for x in json.load(sys.stdin): print(x["path"])')"

# --- Check 4: forbidden paths -----------------------------------------------
echo ""
echo "Check 4: forbidden-path scan"

forbidden_match() {
  local p="$1"
  # Path traversal / absolute path defense
  case "$p" in
    /*)           TRAVERSAL_HITS+=("$p"); return 0 ;;
    *..*)         TRAVERSAL_HITS+=("$p"); return 0 ;;
  esac
  # Absolute /opt/* paths via header oddities
  case "$p" in
    opt/w3forge/*|opt/w3forge|opt/scripts/*|opt/scripts|opt/backups/*|opt/backups|opt/logs/*|opt/logs|opt/update-packages/installed/*|opt/update-package-backups/*)
      FORBIDDEN_HITS+=("$p"); return 0 ;;
  esac
  # Production secrets
  case "$p" in
    .env|.env.local|.env.production|.env.prod|*.env|backend/.env|frontend/.env)
      FORBIDDEN_HITS+=("$p"); return 0 ;;
  esac
  # Build output and dependency caches
  case "$p" in
    node_modules/*|*/node_modules/*|backend/node_modules/*|frontend/node_modules/*)
      FORBIDDEN_HITS+=("$p"); return 0 ;;
    backend/dist/*|frontend/admin/dist/*)
      FORBIDDEN_HITS+=("$p"); return 0 ;;
  esac
  # Git metadata
  case "$p" in
    .git|.git/*|*/.git/*)
      FORBIDDEN_HITS+=("$p"); return 0 ;;
  esac
  return 1
}

# Migration / schema gates
migration_match() {
  case "$1" in
    database/migrations/*) return 0 ;;
  esac
  return 1
}
schema_match() {
  case "$1" in
    database/schema.sql) return 0 ;;
  esac
  return 1
}

# Sensitive (warn) classification
sensitive_match() {
  case "$1" in
    .env.example)                                  return 0 ;;
    database/seeds/*)                              return 0 ;;
    scripts/admin/install-server-scripts.sh)             return 0 ;;
    scripts/doctor-w3forge.sh)                      return 0 ;;
    scripts/deploy-w3forge.sh)                      return 0 ;;
  esac
  return 1
}

# Allowed-prefix classification
allowed_match() {
  case "$1" in
    scripts/*.sh)                  return 0 ;;
    scripts/legacy/*.sh)           return 0 ;;
    scripts/legacy/README.md)      return 0 ;;
    docs/*)                        return 0 ;;
    README.md)                     return 0 ;;
    CHANGELOG.md)                  return 0 ;;
    VERSION)                       return 0 ;;
    package.json)                  return 0 ;;
    backend/package.json)          return 0 ;;
    frontend/admin/package.json)         return 0 ;;
    package-lock.json)             return 0 ;;
    .gitignore)                    return 0 ;;
    .env.example)                  return 0 ;;
    database/seeds/*)              return 0 ;;
    database/migrations/*)         return 0 ;;
    database/schema.sql)           return 0 ;;
    docs)                          return 0 ;;
  esac
  return 1
}

while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  if forbidden_match "$p"; then
    continue   # captured into FORBIDDEN_HITS / TRAVERSAL_HITS
  fi
  if migration_match "$p"; then
    MIGRATION_HITS+=("$p")
    if [[ "$ALLOW_MIGRATIONS" != "1" ]]; then
      ALLOW_VIOLATIONS+=("$p  (requires --allow-migrations)")
    fi
  fi
  if schema_match "$p"; then
    SCHEMA_HITS+=("$p")
    if [[ "$ALLOW_SCHEMA" != "1" ]]; then
      ALLOW_VIOLATIONS+=("$p  (requires --allow-schema)")
    fi
  fi
  if sensitive_match "$p"; then
    SENSITIVE_HITS+=("$p")
  fi
  if ! allowed_match "$p"; then
    ALLOW_VIOLATIONS+=("$p  (path not in allowed set)")
  fi
done <<<"$FILE_LIST"

if (( ${#TRAVERSAL_HITS[@]} > 0 )); then
  echo "  FAIL: path traversal or absolute path detected:" >&2
  for p in "${TRAVERSAL_HITS[@]}"; do echo "    $p" >&2; done
  PROBLEMS=$((PROBLEMS+1))
fi
if (( ${#FORBIDDEN_HITS[@]} > 0 )); then
  echo "  FAIL: forbidden paths detected:" >&2
  for p in "${FORBIDDEN_HITS[@]}"; do echo "    $p" >&2; done
  PROBLEMS=$((PROBLEMS+1))
fi
if (( ${#TRAVERSAL_HITS[@]} == 0 && ${#FORBIDDEN_HITS[@]} == 0 )); then
  echo "  OK: no forbidden or traversal paths"
fi

# --- Check 5: allowlist + migration/schema gates ----------------------------
echo ""
echo "Check 5: allowlist + migration/schema gates"
if (( ${#ALLOW_VIOLATIONS[@]} > 0 )); then
  echo "  FAIL: policy gate failed:" >&2
  for p in "${ALLOW_VIOLATIONS[@]}"; do echo "    $p" >&2; done
  PROBLEMS=$((PROBLEMS+1))
else
  echo "  OK: all paths within allowed set; migration/schema gates satisfied"
fi

# Surface migration / schema hits even when allowed
if (( ${#MIGRATION_HITS[@]} > 0 && ALLOW_MIGRATIONS == 1 )); then
  echo "  WARN (sensitive): database/migrations changes accepted under --allow-migrations:"
  for p in "${MIGRATION_HITS[@]}"; do echo "    $p"; done
  WARNINGS=$((WARNINGS+1))
fi
if (( ${#SCHEMA_HITS[@]} > 0 && ALLOW_SCHEMA == 1 )); then
  echo "  WARN (sensitive): database/schema.sql change accepted under --allow-schema"
  WARNINGS=$((WARNINGS+1))
fi

# --- Check 6: sensitive-path warnings ---------------------------------------
echo ""
echo "Check 6: sensitive-path scan (warn-only)"
if (( ${#SENSITIVE_HITS[@]} > 0 )); then
  for p in "${SENSITIVE_HITS[@]}"; do
    echo "  WARN: sensitive path: $p"
  done
  WARNINGS=$((WARNINGS+${#SENSITIVE_HITS[@]}))
else
  echo "  OK: no sensitive paths"
fi

# --- Check 7: package-lock cohesion -----------------------------------------
echo ""
echo "Check 7: package-lock.json cohesion"
LOCK_PRESENT=0
PKG_ANY_PRESENT=0
while IFS= read -r p; do
  [[ "$p" == "package-lock.json" ]] && LOCK_PRESENT=1
  case "$p" in
    package.json|backend/package.json|frontend/admin/package.json) PKG_ANY_PRESENT=1 ;;
  esac
done <<<"$FILE_LIST"

if (( LOCK_PRESENT == 1 && PKG_ANY_PRESENT == 0 )); then
  echo "  WARN: package-lock.json changed without any matching package.json (root/backend/frontend)"
  echo "        This is permitted but unusual; lock-only changes are usually transitive dep refreshes."
  WARNINGS=$((WARNINGS+1))
  LOCK_ONLY_FLAG=1
elif (( LOCK_PRESENT == 1 )); then
  echo "  OK: lock change paired with package.json change(s)"
else
  echo "  OK: no package-lock.json change"
fi

# Hard stop on any policy failure before running git apply --check
if (( PROBLEMS > 0 )); then
  echo ""
  echo "verify FAILED with $PROBLEMS policy violation(s)."
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 2
fi

# --- Check 8: git apply --check ---------------------------------------------
echo ""
echo "Check 8: git apply --check against $TARGET"
if [[ ! -d "$TARGET" ]]; then
  echo "  FAIL: target $TARGET does not exist" >&2
  PROBLEMS=$((PROBLEMS+1))
elif [[ ! -d "$TARGET/.git" ]]; then
  echo "  FAIL: target $TARGET is not a git working tree (.git missing)" >&2
  PROBLEMS=$((PROBLEMS+1))
else
  APPLY_ERR="$(git -C "$TARGET" apply --check --whitespace=nowarn "$PATCH_FILE" 2>&1)"
  APPLY_RC=$?
  if (( APPLY_RC != 0 )); then
    echo "  FAIL: git apply --check returned $APPLY_RC:" >&2
    while IFS= read -r line; do echo "    $line" >&2; done <<<"$APPLY_ERR"
    PROBLEMS=$((PROBLEMS+1))
  else
    echo "  OK: git apply --check succeeded"
  fi
fi

# --- Summary ----------------------------------------------------------------
echo ""
echo "=== verify summary ==="
echo "  patch         : $PATCH_FILE"
echo "  target        : $TARGET"
echo "  files         : $FILE_COUNT  (A=$ADD_COUNT M=$MOD_COUNT D=$DEL_COUNT R=$REN_COUNT)"
echo "  forbidden     : ${#FORBIDDEN_HITS[@]}"
echo "  traversal     : ${#TRAVERSAL_HITS[@]}"
echo "  sensitive     : ${#SENSITIVE_HITS[@]}"
echo "  lock-only     : $LOCK_ONLY_FLAG"
echo "  problems      : $PROBLEMS"
echo "  warnings      : $WARNINGS"

if (( JSON_OUT == 1 )); then
  echo ""
  echo "--- JSON ---"
  python3 - "$PARSED" <<PY
import sys, json
parsed = json.loads(sys.argv[1])
out = {
  "patch": "$PATCH_FILE",
  "target": "$TARGET",
  "files": parsed,
  "counts": {"total": $FILE_COUNT, "added": $ADD_COUNT, "modified": $MOD_COUNT,
             "deleted": $DEL_COUNT, "renamed": $REN_COUNT},
  "forbidden_hits": ${#FORBIDDEN_HITS[@]},
  "traversal_hits": ${#TRAVERSAL_HITS[@]},
  "sensitive_hits": ${#SENSITIVE_HITS[@]},
  "lock_only": $LOCK_ONLY_FLAG,
  "problems": $PROBLEMS,
  "warnings": $WARNINGS,
}
print(json.dumps(out, indent=2))
PY
fi

if (( PROBLEMS > 0 )); then
  # Distinguish git-apply failure from policy failure for the operator
  if (( ${#FORBIDDEN_HITS[@]} > 0 || ${#TRAVERSAL_HITS[@]} > 0 || ${#ALLOW_VIOLATIONS[@]} > 0 )); then
    echo ""
    echo "verify FAILED (policy)."
    if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
    exit 2
  fi
  echo ""
  echo "verify FAILED (git apply --check)."
  if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
  exit 3
fi

echo ""
echo "[OK] patch is safe to apply ($WARNINGS warning(s))."
if declare -F w3log_done >/dev/null 2>&1; then w3log_done; fi
exit 0
