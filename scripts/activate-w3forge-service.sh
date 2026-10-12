#!/usr/bin/env bash
# Owner-run transition from the legacy unit to the approved root operational unit.
# Run only after testing/building the checkout and taking a VM backup.
set -euo pipefail
[[ "${1:-}" == --yes && $# == 1 ]] || { echo 'Usage: sudo bash scripts/activate-w3forge-service.sh --yes'; exit 2; }
[[ $EUID == 0 ]] || { echo 'Run this owner activation as root.'; exit 2; }

source_root=/opt/w3forge-deploy
runtime=/opt/w3forge
old_unit=w3forge-admin.service
new_unit=w3forge.service
unit_path=/etc/systemd/system/w3forge.service
env_file=/etc/w3forge/admin.env
for tool in node git rsync python3 curl systemctl; do command -v "$tool" >/dev/null; done
for target in "$source_root" "$runtime" /opt/w3forge-scripts "$env_file"; do
  [[ ! -L "$target" ]] || { echo "Refusing symlink: $target"; exit 1; }
done
[[ -d "$runtime" && -s "$env_file" ]]
[[ ! -e "$unit_path" && ! -e "$unit_path.d" ]]
[[ "$(systemctl show "$new_unit" -p LoadState --value)" == not-found ]]
systemctl is-active --quiet "$old_unit"
[[ "$(systemctl show "$old_unit" -p WorkingDirectory --value)" == "$runtime" ]]
[[ "$(git -c safe.directory="$source_root" -C "$source_root" branch --show-current)" == dev/v0.4.2 ]]
[[ -z "$(git -c safe.directory="$source_root" -C "$source_root" status --porcelain)" ]]
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
node "$source_root/scripts/admin-console.cjs" verify
node - "$source_root" <<'CHECK'
const root=process.argv[2];
if(require(root+'/backend/dist/config/env.js').env.serviceName!=='w3forge.service')throw Error('Build the new backend before activation.');
require(root+'/node_modules/node-pty');
CHECK
[[ -s "$source_root/frontend/admin/dist/index.html" ]]
# Keep the own-app repository and path guards in force.
env W3_FORGE_ROOT="$source_root" W3_DEPLOY_DIR="$source_root" W3_SERVICE_NAME=w3forge.service \
  node "$source_root/scripts/admin/_w3forge-policy.cjs" install-server-scripts.sh "$source_root" >/dev/null

install -d -m 0755 /var/backups
snapshot="$(mktemp -d /var/backups/w3forge-service-before.XXXXXXXX)"
chmod 0700 "$snapshot"
cp -a "$env_file" "$snapshot/admin.env"
systemctl is-enabled "$old_unit" > "$snapshot/old-enabled" || true
systemctl cat "$old_unit" > "$snapshot/old-unit.txt"
if [[ -d /opt/w3forge-scripts ]]; then cp -a /opt/w3forge-scripts "$snapshot/scripts"; fi
stage="$(mktemp -d /opt/w3forge.next.XXXXXXXX)"
rsync -a --exclude='.git/' --exclude='.env*' --exclude='logs/' \
  --exclude='.console-source/' --exclude='.test-harness/' "$source_root/" "$stage/"
chmod 0755 "$stage"
chown -R root:root "$stage"
node "$stage/scripts/admin-console.cjs" verify
env W3_FORGE_ROOT="$stage" bash "$stage/scripts/w3-app-config-validate.sh" --app w3forge
printf 'Rollback snapshot: %s\n' "$snapshot"

rollback() {
  rc=$?
  trap - ERR
  set +e
  systemctl disable --now "$new_unit"
  if [[ -e "$unit_path" ]]; then mv "$unit_path" "$snapshot/failed-w3forge.service"; fi
  if [[ -d "$snapshot/runtime" ]]; then
    if [[ -d "$runtime" ]]; then mv "$runtime" "$snapshot/failed-runtime"; fi
    mv "$snapshot/runtime" "$runtime"
  fi
  cp -a "$snapshot/admin.env" "$env_file"
  if [[ -d /opt/w3forge-scripts ]]; then mv /opt/w3forge-scripts "$snapshot/failed-scripts"; fi
  if [[ -d "$snapshot/scripts" ]]; then cp -a "$snapshot/scripts" /opt/w3forge-scripts; fi
  systemctl daemon-reload
  if grep -qx enabled "$snapshot/old-enabled"; then systemctl enable "$old_unit"; fi
  systemctl start "$old_unit"
  echo "Activation failed; attempted rollback to $old_unit. Inspect: $snapshot" >&2
  exit "$rc"
}
trap rollback ERR
systemctl stop "$old_unit"
mv "$runtime" "$snapshot/runtime"
mv "$stage" "$runtime"

# Preserve all existing credentials/origins and change only these explicit settings.
python3 - "$env_file" <<'ENV'
import os, pathlib, re, sys, tempfile
target=pathlib.Path(sys.argv[1])
updates={'W3_FORGE_ROOT':'/opt/w3forge','W3_SERVICE_NAME':'w3forge.service','ADMIN_TERMINAL_ENABLED':'true'}
lines=[]
for line in target.read_text().splitlines():
    match=re.match(r'^\s*([A-Z_]+)\s*=',line)
    if not match or match[1] not in updates:
        lines.append(line)
lines.extend(key+'='+value for key,value in updates.items())
fd,name=tempfile.mkstemp(prefix='.w3forge-service-',dir=target.parent)
try:
    with os.fdopen(fd,'w') as out:
        out.write('\n'.join(lines)+'\n')
    os.chmod(name,0o600)
    os.replace(name,target)
finally:
    if os.path.exists(name): os.unlink(name)
ENV
env W3_FORGE_ROOT="$runtime" W3_DEPLOY_DIR="$source_root" W3_SERVICE_NAME=w3forge.service \
  bash "$runtime/scripts/admin/install-server-scripts.sh"
install -m 0644 "$runtime/config/systemd/w3forge.service" "$unit_path"
systemctl daemon-reload
[[ "$(systemctl show "$new_unit" -p User --value)" == root ]]
[[ "$(systemctl show "$new_unit" -p WorkingDirectory --value)" == "$runtime" ]]
systemctl enable --now "$new_unit"
healthy=false
for attempt in {1..20}; do
  if curl --fail --silent --max-time 3 http://127.0.0.1:8765/health > "$snapshot/health.json"; then
    if node -e 'const d=require(process.argv[1]);process.exit(d.success===true&&d.data?.app==="w3forge"&&d.data?.version==="0.4.2"?0:1)' "$snapshot/health.json" \
      && systemctl is-active --quiet "$new_unit"; then healthy=true; break; fi
  fi
  sleep 2
done
[[ "$healthy" == true ]]
systemctl disable "$old_unit"
trap - ERR
touch "$snapshot/ACTIVATION-COMPLETE"
systemctl show "$new_unit" --no-pager -p ActiveState -p User -p WorkingDirectory
cat "$snapshot/health.json"
printf '\nActivated w3forge.service. Old unit retained but disabled. Snapshot: %s\n' "$snapshot"
