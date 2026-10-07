#!/usr/bin/env bash
# Sourced by every operational entry point before logging or service access.
W3_POLICY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
w3forge_guard_script() {
  local script="$1"; shift
  local config_root="${W3_FORGE_ROOT:-${W3_DEPLOY_DIR:-}}"
  if [[ -z "$config_root" ]]; then
    config_root="$(cd "$W3_POLICY_DIR/../.." && pwd)"
    [[ -f "$config_root/config/apps/w3forge.yml" ]] || config_root="/opt/w3forge-deploy"
  fi
  local resolved
  if ! resolved="$(node "$W3_POLICY_DIR/_w3forge-policy.cjs" "$script" "$config_root")"; then
    echo '===STRUCTURED-RESULT==='
    echo 'status=blocked'
    echo 'reason=installation_policy_or_repository_binding_refused'
    echo '===END==='
    exit 3
  fi
  local line
  while IFS= read -r line; do [[ -z "$line" ]] || export "$line"; done <<< "$resolved"
}
w3forge_require_repository() {
  node "$W3_POLICY_DIR/_w3forge-policy.cjs" "${0##*/}" "$W3_FORGE_ROOT" --check-repository "$1" >/dev/null || exit 3
}
w3forge_require_runtime_layout() {
  local working executable
  working="$(systemctl show "$W3_SERVICE_NAME" --property=WorkingDirectory --value 2>/dev/null)" || return 3
  executable="$(systemctl show "$W3_SERVICE_NAME" --property=ExecStart --value 2>/dev/null)" || return 3
  if [[ "$working" != "$W3_APP_DIR" || "$executable" != *"$W3_APP_DIR/"* ]]; then
    echo '[BLOCKED] Service runtime layout differs from the configured application runtime. Review the staged service migration before deployment.' >&2
    return 3
  fi
}
# Parse only known DB keys in the operator-owned file; never execute an env file.
w3forge_database_env() {
  local resolved line
  if ! resolved="$(node "$W3_POLICY_DIR/_w3forge-policy.cjs" "${0##*/}" "$W3_FORGE_ROOT" --database-env)"; then exit 3; fi
  while IFS= read -r line; do [[ -z "$line" ]] || export "$line"; done <<< "$resolved"
}
# Refuse foreign roots, traversal, links and special files before archive extraction.
w3forge_verify_archive() {
  python3 - "$1" <<'PY'
import re, stat, sys, tarfile, zipfile
try:
    source = sys.argv[1]
    if zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as archive:
            entries = [(item.filename, not stat.S_ISLNK(item.external_attr >> 16)) for item in archive.infolist()]
    else:
        with tarfile.open(source, 'r:*') as archive:
            entries = [(item.name, item.isfile() or item.isdir()) for item in archive.getmembers()]
    if not entries:
        raise ValueError('empty archive')
    for name, regular in entries:
        if not regular or name.startswith('/') or '\\' in name or '..' in name.split('/'):
            raise ValueError('unsafe archive entry')
        if not re.match(r'^(?:w3forge(?:-v[0-9]+\.[0-9]+\.[0-9]+)?|opt/w3forge)(?:/|$)', name):
            raise ValueError('foreign archive root')
except Exception:
    print('[BLOCKED] Archive is invalid or contains foreign roots, traversal, links or special files.', file=sys.stderr)
    sys.exit(3)
PY
}
w3forge_extract_backup() {
  local archive="$1" target="$2"
  [[ "$target" == "$W3_APP_DIR" ]] || return 3
  w3forge_verify_archive "$archive" || return 3
  # Backup archive paths always start opt/w3forge; strip exactly that prefix.
  if tar -tzf "$archive" | grep -vE '^opt/w3forge(/|$)' >/dev/null; then return 3; fi
  tar -xzf "$archive" --strip-components=2 --no-same-owner -C "$target"
}
# npm workspaces links must stay inside the source tree so rsync preserves them safely.
w3forge_verify_workspace_links() {
  node - "$1" <<'JS'
const fs = require('node:fs'), path = require('node:path');
const root = fs.realpathSync(process.argv[2]);
function visit(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const raw = fs.readlinkSync(full), resolved = fs.realpathSync(full);
      if (path.isAbsolute(raw) || !(resolved === root || resolved.startsWith(root + path.sep))) throw new Error('Workspace dependency link escapes the application source tree.');
    } else if (entry.isDirectory()) visit(full);
  }
}
try { for (const relative of ['node_modules', 'backend/node_modules', 'frontend/admin/node_modules']) visit(path.join(root,relative)); }
catch { console.error('[BLOCKED] Dependency links cannot be copied safely to the configured runtime.'); process.exitCode = 3; }
JS
}
