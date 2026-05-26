#!/usr/bin/env bash
#
# w3-app-local-model-test.sh
#
# Smoke-tests the local Ollama runtime for an app context.
#
# Usage:
#   w3-app-local-model-test.sh --app <app_id>
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

# Validate config first.
"$W3_FORGE_ROOT/scripts/w3-app-config-validate.sh" --app "$APP" >/dev/null

CONFIG="$W3_FORGE_ROOT/config/apps/${APP}.yml"

echo "W3 App Local Model Test"
echo "======================="
echo "App: $APP"
echo "Config: $CONFIG"
echo

if ! command -v ollama >/dev/null 2>&1; then
  echo "ERROR: Ollama is not installed or not in PATH."
  exit 1
fi

echo "Ollama binary:"
command -v ollama
echo

echo "Installed models:"
ollama list
echo

MODEL="$(ollama list | awk 'NR==2 {print $1}')"

if [[ -z "${MODEL:-}" ]]; then
  echo "ERROR: No local Ollama models installed."
  exit 1
fi

echo "Testing model: $MODEL"
echo

ollama run "$MODEL" "Reply with exactly: W3 Forge local model test OK"
