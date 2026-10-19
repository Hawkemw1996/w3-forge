# Approved local Forge database setup — v0.4.3

Owner approval: 2026-10-19 (America/Chicago). Scope: PostgreSQL 16 on the Forge VM, dedicated local w3forge database and w3forge_user role, protected configuration/credentials with backups, empty optional PGSSLMODE correction and the existing mandatory backup verification. FIFO change-management ideas are a later design; no FIFO tables or application migrations run here.

## Confirmed host state and changes

Forge is running v0.4.2 with PID 1210 and its original start time. Both the service and the backup helper use /etc/w3forge/admin.env. The backup resolved 127.0.0.1:5432/w3forge; no PostgreSQL server/listener/cluster is present. The owner installed PostgreSQL client 16.15. Repository and package verification pass after the approved detached HOME repair.

The operator shell helper exported empty PGSSLMODE, which libpq rejects before connecting. scripts/admin/_w3forge-policy.sh now unsets that variable only when empty after database bindings are exported. All nonempty values, including invalid values and whitespace, remain unchanged. This does not select or weaken an explicit SSL policy. The app-owned helper was not part of the inherited console provenance inventory; the reviewed source/operator SHA is pinned directly in the setup utility. The immutable previous Test Dev bootstrap bundle is unchanged.

Changed files: AGENTS.md; scripts/admin/_w3forge-policy.sh; scripts/admin/tests/database-environment.test.cjs; scripts/bootstrap-local-database-w3forge.py; scripts/test-local-database-setup.py; this guide. Shared generated source, npm dependencies, Core authentication, existing application migrations and deployment gates are unchanged.

## Reviewed operator behavior

The Python utility requires root and Ubuntu 24.04. It refuses existing clusters/listeners, existing database URLs, conflicting database identities, unrelated credentials and explicit additional PostgreSQL connection options. Existing configuration is parsed as data and unrelated bytes are preserved. It does not adopt, reset or delete a pre-existing database or role.

It records recovery state under root-only /var/lib/w3forge-test/local-database-v1 and generates one password into a root-only recovery file. SQL passwords are sent on protected subprocess stdin, never in arguments or printed output. Native SQL creates only w3forge_user as an ordinary nonsuperuser login with no create-role/create-database/replication/bypass-RLS permissions or role memberships, and its w3forge database. Application tables and FIFO schema are deferred to separate owner-approved work.

Before installing postgresql-16 with --no-install-recommends and --no-upgrade, it verifies the installed PostgreSQL maintainer helper SHA ded9ea805f2dab3f3bcce35965d78622be15ac31565ec6a547db67a943ea3cad. The actual Ubuntu helper creates a cluster without --start, then uses invoke-rc.d for startup. A temporary root-owned policy-rc.d denies service startup during package installation; an existing startup policy causes refusal. NEEDRESTART_MODE=l prevents automatic unrelated service restarts. Only this utility's exact temporary startup policy is removed afterward; an interrupted package operation keeps the protection until it has finished and setup is rerun.

Only the newly created 16/main cluster is configured and started. It listens on 127.0.0.1:5432, uses peer administration for postgres over the Unix socket and SCRAM authentication for the dedicated application database/user. It verifies cluster identity, role restrictions, database ownership, server major, actual connection identity and loopback-only listening. No application service restart, deployment or migration runs.

The protected environment and installed shell helper are backed up before changes. Only the five explicit FORGE_DATABASE host/port/name/user/password bindings are added or updated; conflicting existing values block setup. Every other environment byte is preserved. The shell helper update is limited to the reviewed old/new hashes (c549221bf31570cc3e8e92dca9e06597f436e125dc86acaa5cb0c6bf720e6717 -> 420c4f33dfad83788e01934b4e1b03c7a053e02d08cf1183f8417ea67f0eb0d0).

After connecting successfully, it runs the unchanged installed backup workflow, including that workflow's existing seven-day retention behavior. It requires a fresh nonempty root-private app/SQL pair, readable tar archive and the plain SQL dump's completion evidence. It reports the pair and any normal retention removals. No restore operation is performed. SQL dumps are plain text, so pg_restore --list is not used.

## Owner command

The staged files contain reviewed public code only. Use the existing Forge root Bash terminal to copy the utility into a protected root location, verify that copy, then run it:

```bash
install -o root -g root -m 0700 /home/forgeadmin/w3forge-database-setup/420c4f33dfad/w3forge-database-setup.py /root/w3forge-database-setup.py &&
printf 'f97891e65ab9014c85d45a2d431ba46f32d03ee4af173dfa332dae861b4fb130  /root/w3forge-database-setup.py\n' | sha256sum -c - &&
python3 /root/w3forge-database-setup.py --apply
```

The utility prints structured success, database identity, the new backup paths and confirmation that the Forge PID/start time are unchanged. It does not print the password. Paste that result before the next owner deployment attempt. The currently running app will receive its new database bindings when the owner deploys/restarts it through the existing pipeline.

An ordinary failure retains created resources and recovery credentials. Re-running uses the recorded secret and completed phases rather than rotating passwords. An ambiguous partial resource creation, unexpected drift or changed app service requires operator review instead of automatic adoption. A native package-install failure log stays in the root-only recovery directory.

## Configuration rollback

```bash
python3 /root/w3forge-database-setup.py --rollback
```

Rollback first verifies the app service has not changed, both installed hashes and both original backups. It atomically restores only the environment/helper bytes and original ownership/modes. It refuses to overwrite a later deployment or configuration update. PostgreSQL, its restricted loopback configuration, database, role, credentials and backups are retained for recovery. There is no automatic DROP, package purge or data-directory deletion. Teardown after any application use requires separate owner review.

## Validation

Passed: 358 application tests, type checking, build, parity and pinned 120-file console verification. The eight new shell-boundary cases exercise the actual helper, including inherited/configured empty values and preservation of explicit/invalid values.

```sh
npm run typecheck && npm test && npm run build && npm run console:verify
```

Passed: 13 independent pure operator tests on Windows and Linux as nonroot users, including config-byte preservation, duplicate handling, idempotence, conflict refusal, secret format/role restrictions, listener parsing, atomic-install recovery, drift refusal and rollback refusal after service changes. Operator syntax and nonroot --apply refusal also passed.

```sh
python3 scripts/test-local-database-setup.py
python3 -c 'import ast,pathlib; ast.parse(pathlib.Path("scripts/bootstrap-local-database-w3forge.py").read_text())'
```

These are source/preflight validations. Actual root package installation, database creation and live backup verification occur only when the owner runs the command above and are not claimed as complete beforehand.
