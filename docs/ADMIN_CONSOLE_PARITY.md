# W3 Forge common admin console — implementation and owner activation

Status: development implementation prepared; no live deployment, service privilege change, database provisioning, migration, backup, restore, tag or package operation has been performed by this work.

## Common implementation and configuration boundary

The frontend and operational backend are derived from W3 BuildCost v0.3.9. The active backend mounts backend/src/console; the older backend/src/admin modules remain for the established Forge configuration, network guard and regression fixtures.

The implementation includes the reference dashboard/layout persistence, system status, attention signals, log categories/tails, file roots/listing/previews, staged/dev/main/installed package channels and metadata, paired backups, Git status/tags/commits/version comparison/release notes/dev branches, complete registered controls with validation/confirmation/locks/audits, terminal, production readiness, Core status and audit events. Core authentication remains the identity authority, with PKCE, encrypted server-side Core session tokens, current per-app admin assignment on every request, and same-origin mutation checks.

Only app identity, repository, branch/version data, service/host/filesystem settings, installation credentials and actual operational data vary. Forge uses its own repository, database, packages, backups and service. Product Chat, n8n editing, pricing and business automation belong outside this common console.

Source locations:

- backend/src/console: copied canonical backend; fixed script names and app identifiers bind to Forge.
- frontend/admin: canonical frontend with app configuration bindings.
- scripts/admin: canonical operational scripts adapted to Forge's workspace/build layout.
- config/apps/w3forge.yml: own-app path, repository, service and installation settings.
- config/systemd/w3forge-admin.service: ordinary service template, still forgeadmin.
- config/systemd/w3forge-admin-privileged.conf: separate, optional owner-installed root override.

## Deliberate common safety corrections

These corrections preserve the reference workflows and should be carried back through the common implementation deliberately:

- Git network checks verify the configured own-app repository, pin the checked address, never display credential-bearing remotes or raw command errors, and do not inherit Core/session credentials.
- A failed Git status remains unavailable; a successful empty status means clean.
- Package/backup inventories do not count another app's archives. Installed metadata reads are bounded and do not follow a leaf symlink. File previews reject a public alias resolving to a hidden secret file.
- Artifact success checks and action-lock paths use configured app roots. Artifact checks also verify resolved containment and regular-file type.
- Missing installation opt-ins fail closed. The common controls/pipeline remain available once explicitly configured, with the reference per-action confirmations, validation, fixed action whitelist and lock.
- authority.* is app/agent governance metadata. It is not a replacement for the canonical owner/operator confirmations: an app admin must still complete the exact typed phrases and checkboxes for tag, deploy and recovery operations.
- The active app's configuration is strictly validated independently and freshly. A retained legacy engineering target does not disable Forge. Invalid catalog entries remain diagnostics; no Core version or authority is invented.

The retained config/apps/w3core.yml is an engineering target with no selected canonical version. The catalog reports that limitation while the valid Forge console continues to load.

## Privileges required for the reference operations

The currently prepared ordinary unit runs as forgeadmin. systemd can read a root-owned 0600 EnvironmentFile before changing user; that does not give child scripts permission to read that file.

The reference deployment, backup and recovery scripts need permission to manage the Forge service, write its runtime/script/package/backup roots, read the own-app database settings and perform the selected database operation. forgeadmin alone does not provide those powers. Installing scripts and seeing enabled buttons does not prove the host can execute them.

The smallest arrangement matching BuildCost's reference privilege model is an explicit owner-installed root override. It grants authenticated Core app administrators assigned to Forge the corresponding registered host operations after their confirmations. The default template has not been silently elevated. A narrow privileged broker would be another design, but it is not implemented in this pass.

The owner must choose this privilege mode before the optional override installation below. There is no sudo-all grant or automatic privilege escalation in the application.

## Required host setup before activation

**Run Stage 1 below before executing any provisioning or environment edits in this section.**

Capture the existing installation using Stage 1 below before changing it. Prepare the intended Forge commit in a separate clone of the already approved development branch, as shown in Stage 2. The runtime must be a separate /opt/w3forge tree: pipeline operations change the checkout; service deployment replaces the runtime. Do not keep the new service executing from the development checkout.

The host needs Node/npm supported by the checked-in packages, Bash, Git, curl, rsync, tar/gzip, systemd, and PostgreSQL client tools. Native node-pty must build successfully on that Linux host. PostgreSQL must have a separate Forge database and role; the server refuses a Core/BuildCost database target. No shared business tables are imported from Core.

For a new local database, an owner can provision the role/database once, using password prompts:

    sudo -u postgres createuser --pwprompt w3forge_user
    sudo -u postgres createdb --owner=w3forge_user w3forge

Do not rerun these against an existing installation; inspect the existing role/database first. Store the chosen password locally, never in this repository or a chat.

Preserve /etc/w3forge/admin.env and the existing Core pairing secret, stable installation UUID and separate session secret. Keep the directory root-owned 0700 and the file root-owned 0600. Edit it locally with sudoedit and add the database connection values matching the provisioned Forge database:

    FORGE_DATABASE_HOST=127.0.0.1
    FORGE_DATABASE_PORT=5432
    FORGE_DATABASE_NAME=w3forge
    FORGE_DATABASE_USER=w3forge_user
    FORGE_DATABASE_PASSWORD=<the locally chosen database password>

Both the backend and final operational-script parser support FORGE_DATABASE_URL or DATABASE_URL as an alternative to individual fields. Use a PostgreSQL URL naming the separate Forge database; credentials are decoded locally and are never printed. The script parser supports sslmode only as a URL query option; malformed, unsupported or foreign-app targets fail closed rather than falling back. Do not replace the entire existing file. Keep the existing public Forge/Core origins and COOKIE_SECURE choice consistent with the actual HTTP/HTTPS endpoint.

If the reviewed deploy checkout is owned by forgeadmin while the explicitly chosen service account is root, Git also requires root's trust for that exact checkout. Review it first, then the owner may add only this path with `sudo git config --global --add safe.directory /opt/w3forge-deploy`; do not use a wildcard.

The service account selected for execution needs GitHub access to this app's repository and known SSH host keys. Verify the deploy checkout's effective fetch and push origins both resolve to Hawkemw1996/w3-forge. No script may be redirected to BuildCost/Core. A host SSH alias or credential helper may require connection setup; configure it for the selected account rather than copying another app's private keys.

Remote backups require an explicitly configured Forge-owned remote host, user and path. Until connected, remote backup work must report unavailable/failure truthfully. Also verify ownership and capacity for:

- /opt/w3forge and /opt/w3forge-deploy
- /opt/w3forge-scripts
- /opt/w3forge-update-packages/{dev,main,installed}
- /opt/backups/w3forge
- /opt/logs/w3forge
- /opt/w3forge-data

## Owner-run activation sequence

These commands have not been executed by this implementation. The existing service currently runs from /opt/w3forge-deploy. **Capture Stage 1 before any pull, build, environment edit or checkout change.** A snapshot taken after overwriting those files cannot recover their earlier built code. If the live checkout was already changed without a prior runnable snapshot, stop and locate a known-good deployment backup; the old Git SHA alone does not preserve ignored builds, dependencies or local configuration.

The stages below leave the existing checkout intact throughout preparation. A separate clone uses the existing approved dev/v0.4.1 branch; no new branch is invented, and no local edits are reset or discarded. Provisioning/editing described under host setup above belongs after Stage 1.

### Stage 1 — preserve the currently running installation

This block briefly stops Forge for a consistent copy, captures its actual runnable checkout (including dependencies, built outputs, Git metadata and local configuration), records the old HEAD, and preserves the unit, drop-ins and environment without printing secrets. It restarts the original service only if it was active before the copy. Reserve enough free space for the snapshot, reviewed clone and replacement checkout.

    sudo bash <<'SNAPSHOT'
    set -euo pipefail
    checkout=/opt/w3forge-deploy
    unit=/etc/systemd/system/w3forge-admin.service
    test -d "$checkout/.git"
    test ! -L "$checkout"
    test -s "$checkout/backend/dist/index.js"
    test -s "$checkout/frontend/admin/dist/index.html"
    test -f "$unit"
    test -s /etc/w3forge/admin.env
    if ! test -d /var/backups; then install -d -m 0755 /var/backups; fi
    snapshot="$(mktemp -d /var/backups/w3forge-console-before.XXXXXXXX)"
    chmod 0700 "$snapshot"
    was_active="$(systemctl is-active w3forge-admin.service || true)"
    printf '%s\n' "$was_active" > "$snapshot/was-active"
    git -c safe.directory="$checkout" -C "$checkout" rev-parse HEAD > "$snapshot/old-head"
    git -c safe.directory="$checkout" -C "$checkout" status --porcelain > "$snapshot/old-status"
    trap 'rc=$?; if test "$was_active" = active; then systemctl start w3forge-admin.service || true; fi; exit "$rc"' ERR
    systemctl stop w3forge-admin.service
    cp -a "$checkout" "$snapshot/live-checkout"
    cp -a "$unit" "$snapshot/service"
    cp -a /etc/w3forge/admin.env "$snapshot/admin.env"
    if test -d /etc/systemd/system/w3forge-admin.service.d; then
      cp -a /etc/systemd/system/w3forge-admin.service.d "$snapshot/service.d"
    fi
    for item in runtime scripts; do
      case "$item" in runtime) source_path=/opt/w3forge ;; scripts) source_path=/opt/w3forge-scripts ;; esac
      test ! -L "$source_path"
      if test -d "$source_path"; then cp -a "$source_path" "$snapshot/$item"; fi
    done
    touch "$snapshot/SNAPSHOT-COMPLETE"
    if test "$was_active" = active; then systemctl start w3forge-admin.service; fi
    trap - ERR
    printf 'Keep this rollback snapshot path: %s\n' "$snapshot"
    SNAPSHOT

Keep the printed snapshot path. An incomplete copy has no SNAPSHOT-COMPLETE marker and must not be used to authorize the cutover.

### Stage 2 — build separately, reconcile settings, then cut over

Run the following as the ordinary checkout owner. Enter the exact full SHA of the reviewed commit already published on dev/v0.4.1. The block refuses a different branch tip, so it cannot silently install a newer unreviewed commit. Choose the credential-free HTTPS or SSH URL supported by that account; never embed a password/token in the URL.

    bash <<'PREPARE'
    set -euo pipefail
    read -r -p 'Reviewed full commit SHA: ' reviewed_commit </dev/tty
    [[ "$reviewed_commit" =~ ^[0-9a-fA-F]{40}$ ]]
    read -r -p 'Forge clone URL (credential-free HTTPS or SSH): ' clone_url </dev/tty
    case "$clone_url" in
      https://github.com/Hawkemw1996/w3-forge.git|git@github.com:Hawkemw1996/w3-forge.git) ;;
      *) echo 'Use the exact own-app HTTPS or SSH URL shown above; configure host access first.' >&2; exit 1 ;;
    esac
    stage="$(mktemp -d /var/tmp/w3forge-reviewed.XXXXXXXX)"
    git clone --single-branch --branch dev/v0.4.1 "$clone_url" "$stage"
    cd "$stage"
    test "$(git branch --show-current)" = dev/v0.4.1
    test "$(git rev-parse HEAD)" = "$reviewed_commit"
    test -z "$(git status --porcelain)"
    npm ci
    npm run typecheck
    npm test
    npm run build
    test -z "$(git status --porcelain)"
    printf 'Reviewed staging directory: %s\n' "$stage"
    printf 'Reviewed commit: %s\n' "$reviewed_commit"
    PREPARE

Stop on any failed check. Keep the staging path and reviewed SHA. The original live checkout has not been updated. Compare its local config/apps/w3forge.yml with the staged canonical file in an editor; keep the captured original and reconcile every installation setting deliberately. Do not copy the old reduced YAML over the new canonical schema, and do not run a blanket git restore/reset.

Preserve the existing host's network binding outside the checkout. After Stage 1, edit the existing /etc/w3forge/admin.env with sudoedit and ensure these keys occur once:

    W3_FORGE_ROOT=/opt/w3forge
    W3_ACTIVE_APP_ID=w3forge
    W3_FORGE_ACTIVE_APP=w3forge
    W3_FORGE_ADMIN_HOST=0.0.0.0
    W3_FORGE_ADMIN_PORT=8765
    ADMIN_ALLOW_NON_LOOPBACK=1

W3_FORGE_ROOT must name the new runtime, not the old checkout; an EnvironmentFile value takes precedence over the unit's Environment setting. The checked-in YAML defaults to loopback; omitting these host overrides would make the current remote admin address unreachable after the change. Keep FORGE_PUBLIC_URL, CORE_API_URL/CORE_PUBLIC_URL, COOKIE_SECURE, the approved pairing credentials and stable installation UUID consistent with the existing endpoint. Add the own-Forge database connection settings described above; preserve all existing secret values. Do not run shell source or cat on the environment file.

Complete the database and selected service-account Git prerequisites now. The root-mode installation below requires an explicit decision to grant the reference operational privileges. Git access for the ordinary staging account does not establish Git access for root. Confirm root can read the own deploy checkout and authenticate to the same repository before activating root mode.

The cutover block asks for the exact snapshot/staging paths and reviewed SHA. It preserves the original checkout by moving it intact into the snapshot, so returning to the old unit also returns to the old runnable code. Existing runtime and installed-script directories are similarly retained. If any step after the stop fails, the service remains stopped and the block prints the concrete rollback instruction; it does not restart partially installed code or pretend to roll back the database.

    sudo bash <<'INSTALL'
    set -euo pipefail
    read -r -p 'Stage 1 snapshot directory: ' snapshot </dev/tty
    read -r -p 'Reviewed staging directory: ' stage </dev/tty
    read -r -p 'Reviewed full commit SHA: ' reviewed_commit </dev/tty
    [[ "$snapshot" =~ ^/var/backups/w3forge-console-before\.[A-Za-z0-9]+$ ]]
    [[ "$stage" =~ ^/var/tmp/w3forge-reviewed\.[A-Za-z0-9]+$ ]]
    [[ "$reviewed_commit" =~ ^[0-9a-fA-F]{40}$ ]]
    test "$(readlink -f "$snapshot")" = "$snapshot"
    test "$(readlink -f "$stage")" = "$stage"
    test -f "$snapshot/SNAPSHOT-COMPLETE"
    test -d "$snapshot/live-checkout/.git"
    test -d "$stage/.git"
    test "$(git -c safe.directory="$stage" -C "$stage" branch --show-current)" = dev/v0.4.1
    test "$(git -c safe.directory="$stage" -C "$stage" rev-parse HEAD)" = "$reviewed_commit"
    test -z "$(git -c safe.directory="$stage" -C "$stage" status --porcelain)"
    test -s "$stage/backend/dist/index.js"
    test -s "$stage/frontend/admin/dist/index.html"
    test -s /etc/w3forge/admin.env
    test ! -e "$snapshot/retired-checkout"
    for target in /opt/w3forge-deploy /opt/w3forge /opt/w3forge-scripts; do test ! -L "$target"; done
    printf '%s\n' "$reviewed_commit" > "$snapshot/new-head"
    next_checkout="$(mktemp -d /opt/w3forge-deploy.next.XXXXXXXX)"
    cp -a "$stage/." "$next_checkout/"
    chmod 0755 "$next_checkout"
    trap 'rc=$?; systemctl stop w3forge-admin.service || true; echo "Installation stopped. Run the Rollback block below with snapshot: $snapshot" >&2; exit "$rc"' ERR
    systemctl stop w3forge-admin.service
    touch "$snapshot/CUTOVER-STARTED"
    mv /opt/w3forge-deploy "$snapshot/retired-checkout"
    mv "$next_checkout" /opt/w3forge-deploy
    if test -d /opt/w3forge; then mv /opt/w3forge "$snapshot/retired-runtime"; fi
    if test -d /opt/w3forge-scripts; then mv /opt/w3forge-scripts "$snapshot/retired-scripts"; fi
    install -d -m 0755 /opt/w3forge
    rsync -a --exclude='.git/' --exclude='.env*' --exclude='logs/' \
      --exclude='.cache/' /opt/w3forge-deploy/ /opt/w3forge/
    install -d -m 0700 /opt/w3forge-data /opt/backups/w3forge /opt/logs/w3forge
    install -d -m 0755 /opt/w3forge-update-packages/dev \
      /opt/w3forge-update-packages/main /opt/w3forge-update-packages/installed
    env W3_FORGE_ROOT=/opt/w3forge W3_ACTIVE_APP_ID=w3forge \
      bash /opt/w3forge/scripts/admin/install-server-scripts.sh
    env W3_FORGE_ROOT=/opt/w3forge W3_ACTIVE_APP_ID=w3forge \
      bash /opt/w3forge/scripts/admin/migrate-w3forge.sh
    install -m 0644 /opt/w3forge/config/systemd/w3forge-admin.service \
      /etc/systemd/system/w3forge-admin.service
    install -d -m 0755 /etc/systemd/system/w3forge-admin.service.d
    install -m 0644 /opt/w3forge/config/systemd/w3forge-admin-privileged.conf \
      /etc/systemd/system/w3forge-admin.service.d/privileged.conf
    systemctl daemon-reload
    systemctl reset-failed w3forge-admin.service
    systemctl start w3forge-admin.service
    systemctl --no-pager --full status w3forge-admin.service
    trap - ERR
    printf 'Activated reviewed commit %s; preserve rollback snapshot %s\n' "$reviewed_commit" "$snapshot"
    INSTALL

The default template can remain forgeadmin when root mode is declined, but privileged operations will remain unavailable. The block above explicitly installs the separately documented root override; do not run it when that mode has not been chosen.

After activation, inspect the effective account and runtime, then check the HTTP endpoints:

    sudo systemctl show w3forge-admin.service -p User -p Group -p WorkingDirectory
    curl --fail http://127.0.0.1:8765/health
    curl --fail http://127.0.0.1:8765/version

Sign in through Core and verify Dashboard, GitHub, Controls, Terminal and Production Readiness. The health endpoint does not prove database readiness or privileged-operation success. Use the reference dry-run/validation steps before any real action.

## Rollback

Use the exact completed Stage 1 snapshot. The following restores the original live checkout and built code, unit, drop-ins, original runtime/script directories and pre-change environment. It preserves failed new trees for inspection, does not reset any Git history, and does not remove the database. It is intended for the immediate transition, before additional owner work or credential rotation; later rollback requires reconciling those subsequent changes.

    sudo bash <<'ROLLBACK'
    set -euo pipefail
    read -r -p 'Stage 1 snapshot directory: ' snapshot </dev/tty
    [[ "$snapshot" =~ ^/var/backups/w3forge-console-before\.[A-Za-z0-9]+$ ]]
    test "$(readlink -f "$snapshot")" = "$snapshot"
    test -f "$snapshot/SNAPSHOT-COMPLETE"
    test -f "$snapshot/service"
    test -s "$snapshot/admin.env"
    test -d "$snapshot/live-checkout/.git"
    failure_copy="$(mktemp -d "$snapshot/failed-install.XXXXXXXX")"
    systemctl stop w3forge-admin.service
    for target in /opt/w3forge-deploy /opt/w3forge /opt/w3forge-scripts; do test ! -L "$target"; done
    if test -d "$snapshot/retired-checkout"; then
      if test -e /opt/w3forge-deploy; then mv /opt/w3forge-deploy "$failure_copy/checkout"; fi
      mv "$snapshot/retired-checkout" /opt/w3forge-deploy
    fi
    if test -f "$snapshot/CUTOVER-STARTED"; then
      for item in runtime scripts; do
        case "$item" in runtime) target=/opt/w3forge ;; scripts) target=/opt/w3forge-scripts ;; esac
        if test -d "$snapshot/retired-$item"; then
          if test -e "$target"; then mv "$target" "$failure_copy/$item"; fi
          mv "$snapshot/retired-$item" "$target"
        elif ! test -d "$snapshot/$item" && test -e "$target"; then
          mv "$target" "$failure_copy/$item"
        fi
      done
    fi
    cp -a "$snapshot/service" /etc/systemd/system/w3forge-admin.service
    if test -d /etc/systemd/system/w3forge-admin.service.d; then
      mv /etc/systemd/system/w3forge-admin.service.d "$failure_copy/service.d"
    fi
    if test -d "$snapshot/service.d"; then
      cp -a "$snapshot/service.d" /etc/systemd/system/w3forge-admin.service.d
    fi
    cp -a /etc/w3forge/admin.env "$failure_copy/admin.env"
    cp -a "$snapshot/admin.env" /etc/w3forge/admin.env
    chmod 0600 /etc/w3forge/admin.env
    systemctl daemon-reload
    systemctl reset-failed w3forge-admin.service
    if test "$(cat "$snapshot/was-active")" = active; then
      systemctl start w3forge-admin.service
      systemctl --no-pager --full status w3forge-admin.service
    fi
    printf 'Restored the captured installation; preserved failed files under %s\n' "$failure_copy"
    ROLLBACK

The saved old-head and complete live-checkout copy remain available for recovery even after a successful rollback consumes the retired-checkout directory. If files were manually moved or changed outside this sequence, inspect those records before proceeding; do not substitute a fresh build of an old SHA for the captured runnable tree.

Database migrations are forward-only. Restoring code/environment does not reverse the migration ledger or data. Existing Forge data needs a separate reviewed backup before migration, and database rollback requires the owner's Forge-only backup/restore procedure. Core/BuildCost data must never be a rollback target.

## Verification and remaining live checks

The isolated backend tests exercise canonical contracts, own-app repository/path isolation, current Core app-admin checks, origin protection, unavailable database errors, terminal opt-in and explicit operation confirmation refusal. The frontend is checked locally against the shared implementation; fixture screenshots and browser tests do not establish live connections.

Still required on the actual host: review/install the chosen service privilege mode; provision/connect the Forge database and apply its migration; install the operational scripts; confirm own-repository credentials and remote backup settings; verify native PTY support; and exercise the selected operational workflows with the owner. This document does not claim production readiness.

## Verification record (2026-10-06/07)

This development pass starts from Forge commit 4bce256c969c4f60a95b73961867ee3646ae2ec9 on dev/v0.4.1 and uses BuildCost reference d0cf34c5903940337e162a90771fbe09fd056ce6. The exact changed-file inventory is [ADMIN_CONSOLE_PARITY_CHANGED_FILES.txt](ADMIN_CONSOLE_PARITY_CHANGED_FILES.txt).

Commands and results:

| Environment | Command / check | Result |
| --- | --- | --- |
| Windows workspace | npm.cmd run typecheck | Passed |
| Windows workspace | npm.cmd run build | Passed |
| Windows workspace | npm.cmd test --workspace backend | Initial run: 185 passed, 2 existing Linux shell-spawn tests failed with EFTYPE; retained, not skipped |
| Isolated Linux source copy | npm ci --ignore-scripts --no-audit --no-fund | Passed |
| Isolated Linux source copy | npm run typecheck | Passed |
| Isolated Linux source copy | npm run build | Passed |
| Isolated Linux source copy | npm test, before native dependency rebuild | 192 backend tests passed; terminalRuntime suite could not load pty.node because install scripts were disabled; 92 frontend tests passed |
| Isolated Linux source copy | npm rebuild node-pty | Passed |
| Isolated Linux source copy | npm test | Passed: 196 backend + 92 frontend + 9 operational-script tests = 297 tests; none skipped |
| Both source trees | node scripts/check-console-parity.cjs | Passed: 160 recorded shared-source files, LF-normalized SHA-256 |
| Script tests | Bash syntax checks | Passed for all 49 operational shell files |
| Browser fixtures | full-console-qa.cjs | 22/22 full-page comparisons matched measured text, classes, geometry and computed styles; 8/8 interactive workflows passed |
| Browser fixtures | auth-console-qa.cjs | 5/5 authentication flows passed; no page errors |
| Working tree | git -c core.autocrlf=false diff --check | Passed |
| Installation documentation | Bash -n on all four extracted command blocks | Passed; installation commands were not executed |

Linux verification used a disposable source copy under /tmp/w3forge-parity.0JyG0QcW, never /opt/w3forge-deploy or /opt/w3forge. Database access was redirected to an unused localhost port with a disposable Forge database name; SQL behavior tests used in-process PGlite. Native PTY compilation happened only in that temporary copy. The live service was rechecked afterward: still active since 2026-10-06 22:09:49 EDT, still User=forgeadmin, still WorkingDirectory=/opt/w3forge-deploy, and still at base commit 4bce256.

Local evidence is in the workspace outputs/01a113b1-6aab-76f1-8141-b9b3e2f3410b directory: linux-verification/*.log, full-console-parity/report.json, auth-report.json and complete Forge/reference desktop/mobile screenshots. The browser checks use isolated fixtures, not real GitHub, Core, database or administrative operations.

Dependencies added for reference functionality: pg 8.23.1, @radix-ui/react-dialog 1.1.23 and react-grid-layout 1.5.4; development dependencies @types/pg 8.23.1, @types/react-grid-layout 1.3.6 and @electric-sql/pglite 0.5.8. Root npm workspaces and the root lockfile unify installation/build/test behavior; existing child manifests remain.

Implemented restricted categories: shared auth response/redirect adapters and authorization integration; administrative PostgreSQL schema/migration and audit persistence; dependency additions; owner-operated deploy/package/backup/restore/script preparation; optional service runtime/privilege templates. User confirmed the complete BuildCost feature set and configuration capabilities. No live privilege change, schema migration, release tag, production package, deployment, backup or restore was run.

### Exact comparison limits and inherited issues

The 11 admin pages retain BuildCost's layouts, controls and workflow markup. Only configured identity/paths/machine descriptions and actual data vary. Source is not claimed byte-identical: manifests record configuration bindings and the documented safeguards. Forge retains its existing Core authentication adapter, cookie names and encrypted in-memory sessions, bounded by Core expiry and an eight-hour maximum; restarting the service requires sign-in again. The operational console APIs now use the reference implementation. The existing stronger revocation/logout-race checks, strict origin validation, terminal cleanup, route error boundary and keyboard focus behavior remain.

Two reference issues were intentionally not redesigned only for Forge: mobile Logs/GitHub can overflow horizontally (531px/394px document widths at a 390px viewport), and Settings retains stale reference explanatory copy about GET-only access, local layout storage and authentication. Actual authentication, server-persisted layouts and gated mutations are covered by the tests above. Correct these through a coordinated common-console update, not a Forge-specific layout fork.

The branch is prepared for user review. Live connection and owner-operated workflow checks listed above remain required; this record does not claim production readiness.
