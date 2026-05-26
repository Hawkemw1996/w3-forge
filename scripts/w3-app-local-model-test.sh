#!/usr/bin/env bash
set -euo pipefail

APP="${2:-}"

if [[ "${1:-}" != "--app" || -z "$APP" ]]; then
  echo "ERROR: Usage: $0 --app <app_id>"
  exit 1
fi

CONFIG="/opt/w3forge-deploy/config/apps/${APP}.yml"

if [[ ! -f "$CONFIG" ]]; then
  echo "ERROR: App config not found: $CONFIG"
  exit 1
fi

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