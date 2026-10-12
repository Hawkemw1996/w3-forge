# W3 Forge service name and operational access

The approved service is `w3forge.service`. The application status response, shared UI adapter, app YAML, operator-script defaults and systemd template all use that identity. Legacy `w3forge-admin.service` remains an accepted policy input only for compatibility during transition; new operations target the standard name.

The owner requested the reference operational access model. The new template explicitly runs as root. Terminal access remains subject to the existing Core Forge-admin assignment, same-origin checks, session authorization/revocation and bounded terminal sessions. With `ADMIN_TERMINAL_ENABLED=true`, the existing shared terminal opens a fixed root shell instead of `su --login root`. No password reset, SSH root-login change, sudo-all grant or shared-console source modification is needed.

This gives authenticated Forge administrators host-level operational access. It does not provision a database, grant GitHub repository access, configure remote backup storage, or establish that every control works. The database-unavailable tile must be diagnosed independently using the Forge database configuration; do not use another app's database.

## Prepare the existing host

Keep a current Proxmox backup and an SSH session open. Run as the checkout owner from `/opt/w3forge-deploy`:

```bash
(
set -e
cd /opt/w3forge-deploy
test "$(git branch --show-current)" = dev/v0.4.2
if [ -n "$(git status --porcelain)" ]; then git status --short; exit 1; fi
git pull --ff-only origin dev/v0.4.2
export ADMIN_CONSOLE_GIT_KEY_FILE="$HOME/.ssh/w3_admin_console_read"
npm ci
npm test
npm run typecheck
npm run build
npm run console:verify
)
```

Stop on any failure or unexpected local change. Run these sequentially; the console loader has an exclusive synchronization lock. The test fixtures now bind backup aliases and package-channel directories to their temporary trees, including when called from the pipeline.

The activation script requires a clean `dev/v0.4.2` checkout, a built backend reporting `w3forge.service`, a built frontend, the verified shared-console receipt, loadable native `node-pty`, an active old unit already running from `/opt/w3forge`, and no existing `w3forge.service`. It preserves the existing network settings and credentials, edits only the service/root/terminal settings, installs fresh own-app scripts and disables the old unit after the new service responds. It does not delete the old unit or run database migrations.

```bash
sudo bash /opt/w3forge-deploy/scripts/activate-w3forge-service.sh --yes
```

The script prints a root-only rollback snapshot under `/var/backups/w3forge-service-before.*`. It retains the previous runtime intact, previous environment, script inventory, unit description and enabled state. A failure after stopping the old service triggers an attempted restoration and restart of that service; inspect its result rather than assuming recovery. Preparation failures leave the live service running. Do not rerun blindly against a partly completed activation.

## Verify the host

```bash
sudo systemctl show w3forge.service --no-pager -p User -p Group -p WorkingDirectory -p ActiveState
sudo systemctl is-enabled w3forge-admin.service || true
curl --fail http://127.0.0.1:8765/health
```

Sign in through Core, confirm System Status reports `w3forge.service`, then open Terminal and run `whoami` (expected `root`). Confirm closing/logging out ends terminal access. A successful health check alone does not validate database, backup or deployment actions.

The root service also needs access to the Forge Git origin and the private console source for future updates. Root can read the existing protected Forge keys, but needs its own trusted GitHub host keys. Preserve the canonical `git@github.com:Hawkemw1996/w3-forge.git` origin, configure only Forge-owned keys, and never disable SSH host verification. Persist `ADMIN_CONSOLE_GIT_KEY_FILE=/home/forgeadmin/.ssh/w3_admin_console_read` in the protected environment file if using that existing dedicated key. Do not copy Core or other app credentials.

## Manual immediate rollback

If activation succeeded but application acceptance fails, use the exact printed snapshot path. Stop `w3forge.service`, disable it, move the new runtime aside for inspection, restore the snapshot's `runtime` to `/opt/w3forge`, restore `admin.env` and the previous script directory, reload systemd, then re-enable/start the retained `w3forge-admin.service` according to `old-enabled`. Preserve all failed files and the snapshot. Neither this rollback nor activation changes database state. The Proxmox backup remains the full-VM recovery option.
