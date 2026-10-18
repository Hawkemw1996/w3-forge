# Approved Test Dev host setup — W3 Forge v0.4.3

The owner approved this host-only setup in the conversation on 2026-10-17 (America/Chicago). Application deployment, restart and database changes are outside this operation. The current v0.4.2 installed Test Dev wrapper runs npm in the checkout as root; the new worker requires the separate build identity. Do not weaken the main-branch refusal test or root parser guard.

## Reviewed operation

Use scripts/bootstrap-test-dev-host-w3forge.py only as a separately reviewed, checksum-verified root-owned operator utility. It reads the eight fixed, hash-pinned public helpers from /home/forgeadmin/w3forge-host-setup/9b6c13aae7ff. Each input is opened without following a link, checked for regular-file identity and exact SHA-256, and copied to protected root-owned /opt/w3forge-testdev-helpers/9b6c13aae7ff before execution. No development npm command runs as root.

The utility provisions w3forge-testbuild as a dedicated nonlogin system account with only its own primary group. Snapshot root /var/lib/w3forge-test/snapshots is root:root 0711; cache /var/cache/w3forge-test/cache is build-account-owned 0700 under protected root-owned parents. Existing conflicting accounts/paths fail closed. The account must be unable to read /etc/w3forge/admin.env, traverse /opt/w3forge-data, or write the runtime/helper installation.

It records and removes only group/other write bits on the existing runtime YAML package and its necessary runtime ancestors after validating root ownership, regular paths and no links. It records original modes/inodes, backs up the installed Test Dev wrapper and complete existing environment file in a root-only timestamped directory, and appends only the seven fixed nonsecret W3_TEST bindings. Existing different or duplicate bindings block setup. Credentials are never printed or passed to a worker.

The temporary installed /bin/sh bridge clears the caller environment with /usr/bin/env -i, passes fixed bindings to the exact reviewed canonical wrapper and derives the supervising PID from its actual kernel PPID. It never accepts a caller-selected executable, config path or owner PID. The canonical capability/repository/confirmation/main-branch checks remain. The supervisor validates code ownership, creates and verifies the exact committed credential-free source snapshot and drops to the build account before the common worker runs the complete existing npm command. The normal owner-controlled v0.4.3 deployment replaces this temporary bridge with the canonical wrapper; the new backend then forwards the already configured bindings. No service restart is needed for this temporary host launcher.

The snapshot helper adds safe.directory for only the validated canonical checkout on each hardened offline Git read. There is no wildcard/global trust entry and no checkout ownership change. This permits a root supervisor to inspect the forgeadmin-owned checkout while preserving disabled hooks/fsmonitor/network/lazy fetch/object replacement and exact source checks.

## Owner command

After reviewing the utility, use an existing root terminal on W3 Forge. Copy it to the protected root directory before checking its checksum and executing it:

```bash
install -o root -g root -m 0700 /home/forgeadmin/w3forge-host-setup/9b6c13aae7ff/w3forge-testdev-bootstrap.py /root/w3forge-testdev-bootstrap.py &&
printf "eb0d00fcf0a86042825a0e4b6a8f2ac24d418fb6a03ea9e7fed7f595d9eecdb9  /root/w3forge-testdev-bootstrap.py\n" | sha256sum -c - &&
python3 /root/w3forge-testdev-bootstrap.py --apply --test
```

The utility first checks the installed guard with --help, then optionally runs the real isolated Test Dev command. It compares the live service PID/start time before and after. A setup/preflight error restores the prior wrapper/settings and changed modes; created account/cache/versioned helper directories are retained for owner review. An isolated test failure retains the installed host setup and its failure log rather than concealing the failure. No snapshot leftovers are deleted automatically.

## Rollback

The utility prints the exact root-only backup directory and rollback command. Rollback refuses if wrapper/environment hashes or parser inode/modes have changed after setup; it does not overwrite a subsequent deployment. It restores the prior wrapper, environment file and parser modes and leaves the dedicated account/cache/versioned helper directories for deliberate owner cleanup. This does not revert application code or data.

## Verification and live boundary

The complete source gate passed as an unprivileged Node 22.23.3 container with injected host script/log aliases: npm run typecheck && npm test && npm run build && npm run console:verify (343 tests, zero failures). A separate native-prepared, root-owned source fixture first reproduced Git dubious-ownership refusal for the unprivileged node user; the patched installed-layout snapshot helper then completed source validation, exact committed snapshot creation and 120-file console verification as that nonroot user. Root in that fixture executed only native preparation commands; all development JavaScript ran after runuser dropped privilege.

Bootstrap Python syntax, all eight payload checksums, environment-byte preservation, idempotent binding append, duplicate/conflicting binding refusal, /bin/sh syntax and nonroot refusal were checked separately. This is not a claim that host provisioning or root acceptance ran. Current SSH cannot authenticate as root or use passwordless sudo, and browser control is unavailable; the owner command above is required to finish host acceptance. No production privilege/configuration change was applied from this session.
