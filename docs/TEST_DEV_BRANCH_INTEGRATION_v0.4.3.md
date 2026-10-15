# Test Dev Branch integration — w3forge v0.4.3

Status: prepared for isolated verification; not adopted or deployed. Branch: dev/v0.4.3. Starting app commit: 5de7b1b807cda421e867ea0eabde17cdb7d175c6.

## Change and adoption boundary

The owner approved the common v0.3.0 worker/progress/cache contract and this separate consumer integration on 2026-10-14. The app wrapper retains its original argument, confirmation, branch, logging and app-policy checks, then delegates to a separately installed trusted host supervisor. The supervisor verifies exact committed source and the console manifest, creates a credential-free snapshot, transfers it to a separate non-login build account and invokes the common worker after dropping privilege. It never runs npm or development code as root.

The worker performs one deterministic root workspace npm ci, declared lint and the complete existing npm test, including lifecycle hooks and database/shell/frontend checks. New refusal regressions are appended to the root test command. No existing test, command or assertion was removed. Cache reuse retains npm integrity checks and fresh node_modules. No application business logic, authentication, assignments, schema, dependency or deployment/promotion workflow was changed.

The console lock remains unchanged at af16fb7535a0e848eea35e5f5e2e2b2e8a90a5fa, version 0.2.0, manifest 700fa91e6145a6279e4e118a7e5972f1b4e3a635f82de12aec6ee7e7786816e7. This integration does not update a pin. The new wrapper fails closed until the owner separately adopts a reviewed v0.3.0 source pin and provisions the required non-secret bindings. Do not install the new wrapper alone on a live host. The current pin can still typecheck the additive adapter bindings; it does not implement the new progress contract or supply the worker.

## Operator-controlled host prerequisites

All prerequisites require owner review and installation; none was applied to a live app by this task.

| Binding | Requirement |
|---|---|
| W3_TEST_INSTALLATION_ID | Stable, unique non-secret ID for this app installation; required to enable adapter bindings |
| W3_TEST_BUILD_USER | Dedicated non-root system account, non-login shell, only its own primary group; no production/data/database privileges |
| W3_TEST_PRODUCTION_USER | Actual production service/data owner; must have a different UID |
| W3_TEST_SNAPSHOT_ROOT | Dedicated root-owned parent, mode 0711, root-owned ancestors without group/other write access; outside source/data/cache |
| W3_TEST_CACHE_ROOT | Dedicated build-account-owned mode 0700 directory, protected root-owned ancestors; outside source/data/snapshots |
| W3_TEST_NPM_CLI | Canonical root-owned host npm CLI file with protected ancestors; outside the snapshot |
| W3_TEST_CACHE_EPOCH | Optional safe generation ID; increment to invalidate cached content without modifying active generations |
| W3_TEST_OWNER_PID | Supplied by the common backend for each operation, never by an HTTP path/PID parameter |

Existing W3_ENV_FILE and W3_DATA_DIR bindings remain authoritative. The supervisor checks that the build account cannot read the protected environment or traverse production data. Every installed helper and its parents must be root-owned and not writable by other accounts. The existing installer copies the separately tracked helpers; a shared source-pin update never replaces these trusted executables implicitly.

A leftover snapshot blocks the next run for operator recovery. Normal failure, timeout, cancellation and backend loss terminate the worker's process groups and attempt identity-checked cleanup. Forced supervisor SIGKILL, host failure, resource budgets and real filesystem/database ACLs require host acceptance; an isolated source test is not proof of production recovery. Keep any owner supervisor/cgroup protections in place. Do not delete a leftover based only on build-writable metadata.

## Source integrity

Common helper source reviewed at w3-admin-console commit 05a04e8af8794411766b2e1b1cfbdd9171065abc:

- scripts/admin/test-dev-host.cjs SHA-256: dafe6b9fcaa32ddb212015f8cea25cb9c9cc9eef64de1a92e3e375714908066a
- scripts/admin/test-dev-snapshot.cjs SHA-256: f62613479998731aa7fd36dc5c3d5da199bc7241729bd69f2c1d8730b29c198c

Propagate common helper fixes deliberately to all three consumers. The public admin-console.cjs loader is retained; generated common frontend/backend files remain ignored and are not app-owned forks.

## Verification and performance evidence

Run npm ci, npm run console:verify, npm run typecheck, npm test and npm run build in credential-free disposable snapshots. Run npm run lint only where declared. The complete root test command includes node --test scripts/test-test-dev-integration.cjs. The new cases exercise required host isolation, correlated configuration failure, the actual wrapper's main-branch refusal and trusted installer inventory.

Full isolated Linux tests, native PostgreSQL migration cases and old/new wrapper cold/warm benchmarks are pending at this checkpoint. Use synthetic disposable databases and no host mounts; never use an installed /opt wrapper or production database as a benchmark. Report actual commands, exit codes, counts and measured timings before claiming acceptance. Source gates and app Test Dev Branch timings are different measurements.

No main/tag/package/deployment operation is authorized. Declining adoption preserves the existing installation. Review-only rollback is reverting this app integration through its development branch; do not change persistent data or invalidate another active operation's cache lock.
