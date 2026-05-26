#!/usr/bin/env bash
#
# w3-app-review-report.sh
#
# Generate a human-readable review report for an app.
# Part of the W3 Forge v0.3.0 review layer.
#
# Usage:
#   w3-app-review-report.sh --app <app_id> [--base <ref>] [--output <file>]
#
# Behavior:
#   - Validates the app config first.
#   - Composes a markdown report covering app identity, branch/commit,
#     workflow readiness result, diff summary, changed files, recent
#     commits, warnings/errors, and an explicit safety confirmation.
#   - Prints the report to stdout by default.
#   - With --output <file>, also writes the report to a markdown file.
#     The path must resolve inside $W3_FORGE_ROOT/docs/reports/ or
#     $W3_FORGE_ROOT/logs/reports/. Anything else is refused.
#   - Read-only except for the optional report file.
#   - Never deploys, never tags, never pushes.
#
set -euo pipefail

W3_FORGE_ROOT="${W3_FORGE_ROOT:-/opt/w3forge-deploy}"

APP=""
BASE=""
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP="${2:-}"
      shift 2
      ;;
    --base)
      BASE="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
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

# Validate config first.
"$W3_FORGE_ROOT/scripts/w3-app-config-validate.sh" --app "$APP" >/dev/null

# ---------------------------------------------------------------------------
# YAML helpers
# ---------------------------------------------------------------------------

top_level_value() {
  local key="$1"
  awk -v key="$key" '
    $0 ~ "^"key":" {
      sub("^"key":[ \t]*", "")
      gsub(/^["'\'']|["'\'']$/, "")
      print
      exit
    }
  ' "$CONFIG"
}

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

NAME="$(top_level_value name)"
WORKSPACE="$(section_value paths workspaces)"

# ---------------------------------------------------------------------------
# Validate --output path if provided
# ---------------------------------------------------------------------------

# canonicalize_parent <path>
#   Returns the canonical absolute path of the parent directory of <path>,
#   creating it if it falls inside an allowed report root.
allowed_report_root() {
  local p="$1"
  case "$p" in
    "$W3_FORGE_ROOT/docs/reports"|"$W3_FORGE_ROOT/docs/reports/"*) return 0 ;;
    "$W3_FORGE_ROOT/logs/reports"|"$W3_FORGE_ROOT/logs/reports/"*) return 0 ;;
  esac
  return 1
}

if [[ -n "$OUTPUT" ]]; then
  # Resolve to absolute path. Relative paths resolve against W3_FORGE_ROOT.
  case "$OUTPUT" in
    /*) ABS_OUTPUT="$OUTPUT" ;;
    *)  ABS_OUTPUT="$W3_FORGE_ROOT/$OUTPUT" ;;
  esac

  # Canonicalize by computing the parent's realpath, then re-attaching the
  # basename. This defeats `..` traversal without requiring the file to exist.
  PARENT_DIR="$(dirname "$ABS_OUTPUT")"
  BASE_NAME="$(basename "$ABS_OUTPUT")"

  # Ensure parent directory exists only if inside an allowed root.
  if ! allowed_report_root "$ABS_OUTPUT"; then
    echo "ERROR: --output must be inside $W3_FORGE_ROOT/docs/reports/ or $W3_FORGE_ROOT/logs/reports/"
    echo "       Got: $ABS_OUTPUT"
    exit 1
  fi

  mkdir -p "$PARENT_DIR"

  # Resolve realpath now that parent exists, then re-check containment.
  REAL_PARENT="$(cd "$PARENT_DIR" && pwd -P)"
  REAL_OUTPUT="$REAL_PARENT/$BASE_NAME"

  if ! allowed_report_root "$REAL_OUTPUT"; then
    echo "ERROR: Resolved --output path escapes allowed report roots:"
    echo "       $REAL_OUTPUT"
    exit 1
  fi

  OUTPUT="$REAL_OUTPUT"
fi

# ---------------------------------------------------------------------------
# Gather data
# ---------------------------------------------------------------------------

REPORT_DATE="$(date -u +"%Y-%m-%d %H:%M:%S UTC")"

BRANCH=""
HEAD_SHA=""
DIRTY=""
WS_STATE="MISSING"
if [[ -n "${WORKSPACE:-}" && -d "$WORKSPACE/.git" ]]; then
  BRANCH="$(cd "$WORKSPACE" && git branch --show-current)"
  HEAD_SHA="$(cd "$WORKSPACE" && git rev-parse --short HEAD 2>/dev/null || echo none-yet)"
  DIRTY="$(cd "$WORKSPACE" && git status --short)"
  WS_STATE="OK"
fi

# Workflow status (capture both stdout and exit code).
WORKFLOW_OUT="$( "$W3_FORGE_ROOT/scripts/w3-app-workflow-status.sh" --app "$APP" 2>&1 || true )"
WORKFLOW_FINAL="$(echo "$WORKFLOW_OUT" | awk '/^Final$/ { getline; getline; print; exit }')"
if [[ -z "$WORKFLOW_FINAL" ]]; then
  # Fallback: pull the last non-empty line.
  WORKFLOW_FINAL="$(echo "$WORKFLOW_OUT" | awk 'NF{last=$0} END{print last}')"
fi

# Diff summary.
DIFF_ARGS=(--app "$APP")
if [[ -n "$BASE" ]]; then
  DIFF_ARGS+=(--base "$BASE")
fi
DIFF_OUT="$( "$W3_FORGE_ROOT/scripts/w3-app-diff-summary.sh" "${DIFF_ARGS[@]}" 2>&1 || true )"

# Pull base ref used (echoed by diff-summary).
BASE_USED="$(echo "$DIFF_OUT" | awk -F': ' '/^Base: / {print $2; exit}')"

# Changed files block (between markers).
CHANGED_BLOCK="$(echo "$DIFF_OUT" | awk '
  /^Changed files$/ { capture=1; next }
  capture && /^---/ { next }
  capture && /^Diff stat$/ { exit }
  capture { print }
')"

# Commits block.
COMMITS_BLOCK="$(echo "$DIFF_OUT" | awk '
  /^Commits / { capture=1; next }
  capture && /^---/ { next }
  capture && /^Working tree$/ { exit }
  capture { print }
')"

# Warnings/errors collected from workflow + diff output.
WARN_BLOCK="$(echo "$WORKFLOW_OUT" | grep -E '^(WARN|ERROR):' || true)"

# ---------------------------------------------------------------------------
# Compose report
# ---------------------------------------------------------------------------

REPORT="$(cat <<EOF
# W3 Forge Review Report — ${NAME:-$APP}

Generated: $REPORT_DATE
App: $APP
Config: $CONFIG
Workspace: ${WORKSPACE:-(unset)}

## Branch and commit

- Branch: ${BRANCH:-(no workspace)}
- HEAD: ${HEAD_SHA:-(no workspace)}
- Base ref: ${BASE_USED:-(not resolved)}
- Workspace state: $WS_STATE

## Workflow readiness

Final state from \`w3-app-workflow-status.sh --app $APP\`:

\`\`\`
${WORKFLOW_FINAL:-(unavailable)}
\`\`\`

Full workflow output:

\`\`\`
$WORKFLOW_OUT
\`\`\`

## Changed files

\`\`\`
${CHANGED_BLOCK:-(none)}
\`\`\`

## Recent commits

\`\`\`
${COMMITS_BLOCK:-(none)}
\`\`\`

## Warnings and errors

\`\`\`
${WARN_BLOCK:-(none)}
\`\`\`

## Working tree

\`\`\`
${DIRTY:-Clean.}
\`\`\`

## Safety confirmation

This report was generated by W3 Forge v0.3.0 review layer. The
generating run:

- did not modify \`main\`
- did not merge into \`main\`
- did not create a release tag
- did not deploy
- did not move packages into \`/opt/update-packages\` or its installed/ subtree
- did not modify persistent production data

W3 Forge proposes and validates changes. W3 Core remains the production
deployment authority. The user owns the final release gate.
EOF
)"

# ---------------------------------------------------------------------------
# Emit report
# ---------------------------------------------------------------------------

echo "$REPORT"

if [[ -n "${OUTPUT:-}" ]]; then
  # Write atomically.
  TMP="$(mktemp "${OUTPUT}.tmp.XXXXXX")"
  printf '%s\n' "$REPORT" > "$TMP"
  mv "$TMP" "$OUTPUT"
  echo
  echo "Report written to: $OUTPUT"
fi
