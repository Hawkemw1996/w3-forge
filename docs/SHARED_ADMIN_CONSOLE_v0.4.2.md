# W3 Forge v0.4.2: Shared Admin Console

This development integration is based on `5a82e49f3048650cb71fc2fb372827ac3c5bd7dd` and stays on `dev/v0.4.2`. W3 Core is not modified or made a consumer.

## Source contract

- **Repository:** [W3 Admin Console](https://github.com/Hawkemw1996/w3-admin-console), private, approved `dev/v0.1.0`.
- **Pin:** `104e6494ab388eeae8f46593f2695c02d2e303eb`, version 0.1.0, API contract 1. The authoritative checksum and destination mapping are in `admin-console.lock.json`.
- **Common implementation:** 113 files, consisting of 44 backend, 57 frontend and 12 shared-UI files. All three apps consume the same exact bytes, not identity-normalized forks.
- **App boundary:** `backend/src/adminConsoleAdapter.ts` supplies product identity, current installation paths, terminal authorization, database and optional backup bindings. Existing auth and same-origin/network guards remain in the app composition.
- **Navigation:** Dashboard, System Status, Logs, Packages, Backups, File Browser, GitHub / Releases, Terminal and Controls. Settings and Production Readiness frontend pages/routes are removed. Compatibility backend endpoints and historical records are retained.

Forge is public; the shared repository is private. Generated shared files must stay ignored and untracked. The public loader, lock, adapter and tests contain no private source payload. The Forge product entry, public/authentication pages and still-used legacy backend helpers remain app-owned. Operator-script sources remain in scripts/admin. Existing script provenance remains enforced separately from the canonical console manifest.

## Development and first adoption

Use Node.js 22 or newer. Provision read-only access to the private shared repository on the development/build account before a fresh install. Use an approved credential helper or a dedicated protected deploy key specified by `ADMIN_CONSOLE_GIT_KEY_FILE`; never embed a token in a URL or reuse Core/database/provider credentials.

```sh
npm ci
npm run console:verify
npm run typecheck
npm test
npm run build
```

For CI, provision the repository secret `ADMIN_CONSOLE_READ_TOKEN` with read-only contents access to the shared repository. The workflow checks out the exact pin and runs the same verification sequence. This integration does not create that secret or claim a successful remote CI run before it is provisioned.

Before the owner packages the first integration release, refresh the app's installed operator wrappers with its existing reviewed `install-server-scripts.sh` procedure. The installed package wrapper must call `scripts/admin-console.cjs archive`, not plain `git archive`, or it will omit ignored shared files. Books must also install the approved `admin-console.cjs` helper listed in its operations manifest. Do not run a production deployment as part of this setup review.

The resulting app source package contains the complete verified console and its manifest/receipt. A deployment build can use those bytes without private-repository access. Raw GitHub ZIPs and plain `git archive` output are not complete offline app source packages after this integration.

## Updating through the existing pipeline

1. Review and test a common change on the explicitly approved shared development branch, regenerate its manifest, and push that branch.
2. In this app's GitHub / Releases page, open Shared Admin Console, check references, select the reviewed full commit SHA and type `UPDATE ADMIN CONSOLE`.
3. Stage into a clean, approved app development checkout. The running pin remains distinct from the staged checkout pin; staging does not alter production.
4. Run app tests, review and commit the app lock change, then continue the existing owner-controlled package/verification/deployment workflow.
5. Adopt the same reviewed commit in the other apps when fleet-wide parity is desired. There is no implicit update from a moving branch and no automatic production deployment.

```sh
npm run console:refs
npm run console:update -- --revision <reviewed-full-sha> --expected <current-full-sha>
```

Local common-source edits, changed expected pins, invalid manifests, symlinks, unsupported API versions, dirty checkouts and non-development branches are refused. Preserve local edits for review in the shared repository rather than bypassing verification. Revert an app's lock to a reviewed compatible commit for a source rollback; that does not roll back database state or a live installation.

## Verification scope and operator gate

Acceptance covers clean dependency installation, TypeScript checks, complete existing app test suites, source-contract tests, builds, byte-for-byte parity, loader rollback/offline archives, and browser checks. The detailed cross-app report records counts and evidence. Test archives and databases are disposable fixtures, never final release packages or production migrations.

Before release, the owner must still validate native host permissions, the installed script inventory, the real Core/browser session path, private-source access, PostgreSQL compatibility, backup integrity, isolated restore and rollback on the intended Debian/systemd installation. Main merges, release tags, final production packages and deployments remain owner-only.
