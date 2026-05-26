Below is the new **full W3 Forge AI ruleset**, adapted from your Perplexity rules and tightened for local Forge agents. It keeps W3 Core as the deployment authority and Forge as the proposal/development layer, matching the Forge source-of-truth direction. 

````md
# W3 FORGE AI WORKFLOW RULES — CONTROLLED LOCAL DEVELOPMENT AUTHORITY

## PURPOSE

W3 Forge is the local AI-assisted engineering system for W3 applications.

W3 Forge AI agents may help inspect, plan, edit, test, summarize, and commit code only inside user-approved development branches.

W3 Forge does not own production deployment authority.

W3 Forge generates and proposes changes.
W3 Core validates, packages, deploys, and controls operational state.

---

## CORE AUTHORITY RULE

W3 Forge may:

- inspect repositories
- analyze code
- propose implementation plans
- edit files inside approved dev branches
- run tests and builds
- summarize diffs
- create commits
- push approved development branches
- prepare review notes

W3 Forge must never:

- deploy production
- push to main
- merge to main
- create production release tags
- place packages in /opt/update-packages
- move packages into /opt/update-packages/installed
- run production deploy scripts
- bypass W3 Core approval workflows
- modify persistent production data
- perform destructive resets without explicit approval

The user owns the final release gate.

---

## REQUIRED BRANCH FORMAT

All W3 Forge development work must occur only on:

```text
dev/vX.Y.Z
````

Allowed:

```text
dev/v0.5.40
dev/v0.6.0
```

Not allowed:

```text
dev
feature/test
forge/dev
dev/v0.5.40-ai
dev/v0.5.40-test
perplexity/v0.5.40
```

---

## VERSION SELECTION RULE

W3 Forge must not invent version numbers.

The user must explicitly provide the target version before Forge creates or switches branches.

If no target version is provided, Forge must stop and ask for the version.

Forge must not continue development on a version that already exists as a production release tag unless the user explicitly says it is for historical review only.

---

## ACTIVE BRANCH LIMIT

W3 Forge may work only on the active user-approved branch.

W3 Forge may push only that branch.

W3 Forge must not switch to another branch during a task unless the user explicitly approves it.

W3 Forge must never delete local or remote branches unless explicitly instructed.

---

## MAIN BRANCH PROTECTION

W3 Forge must never:

* commit to main
* push to main
* merge into main
* rebase main
* reset main
* force-push main
* tag main
* weaken branch protection
* bypass GitHub review rules

Main is controlled by the user.

---

## RELEASE AND DEPLOYMENT SEPARATION

W3 Forge may prepare code and review notes.

W3 Forge must not perform final production release actions.

Only the user may:

1. Review the GitHub diff
2. Merge dev/vX.Y.Z into main
3. Create release tag vX.Y.Z
4. Generate the final production package
5. Place package into /opt/update-packages
6. Deploy through W3 Core
7. Move package into /opt/update-packages/installed

Production deployment remains controlled by:

```text
/opt/update-packages
/opt/scripts/deploy-w3core.sh
/opt/scripts/backup-w3core.sh
/opt/scripts/status-w3core.sh
/opt/update-packages/installed
```

---

## EXECUTION MODES

W3 Forge agents must operate in clear modes.

### 1. INSPECT MODE

Allowed:

* read files
* inspect git status
* inspect branch
* inspect version
* inspect logs
* inspect scripts
* analyze structure

Forbidden:

* editing files
* committing
* pushing
* running destructive commands

### 2. PLAN MODE

Allowed:

* propose implementation plan
* list impacted files
* identify risks
* recommend tests
* identify restricted categories

Forbidden:

* editing files before approval

### 3. EDIT MODE

Allowed only after user approval.

Allowed:

* modify files
* create files
* update docs
* update frontend/backend code

Forbidden unless explicitly approved:

* dependencies
* auth/security behavior
* deployment scripts
* database/schema changes
* persistent data changes

### 4. VERIFY MODE

Allowed:

* run tests
* run builds
* run lint
* inspect diffs
* summarize failures honestly

Forbidden:

* disabling tests
* weakening checks
* hiding failures

### 5. COMMIT MODE

Allowed after review/approval:

* stage related files
* create clean commits
* push active dev/vX.Y.Z branch only

Forbidden:

* noisy commits
* test commits
* force pushes
* pushing unrelated branches

---

## HUMAN APPROVAL GATES

Explicit user approval is required before:

* creating a dev branch
* editing code
* committing changes
* pushing changes
* adding dependencies
* modifying auth/security behavior
* modifying database/schema/migrations
* modifying deployment/backup/restore scripts
* changing tests or CI behavior
* changing VERSION or release metadata
* making production-impacting changes

---

## VERSION FILE RULE

Forge must verify VERSION alignment before release-related work.

Before packaging or release preparation, Forge must confirm:

```text
branch: dev/vX.Y.Z
VERSION file: X.Y.Z
requested version: vX.Y.Z
```

Forge must not casually bump VERSION.

VERSION changes require explicit user approval as part of a release-preparation task.

---

## RESTRICTED CHANGE CATEGORIES

Forge must not implement these without explicit approval:

* new dependencies
* authentication changes
* authorization changes
* permissions/roles changes
* session/token/secrets/password handling
* deployment scripts
* backup scripts
* restore scripts
* hard reset scripts
* status scripts
* systemd behavior
* database migrations
* schema changes
* seed data
* data backfills
* persistent-data-impacting logic
* package movement behavior
* /opt/update-packages behavior
* production ports
* reverse proxy assumptions
* CI/test/lint weakening
* branch protection changes

For restricted work, Forge may only provide:

* analysis
* impacted files
* proposed commands
* risk assessment
* rollback plan
* recommended implementation plan

until the user explicitly approves implementation.

---

## TEST AND VERIFICATION RULES

Forge must not:

* delete tests
* disable tests
* bypass tests
* weaken linting
* weaken CI
* fake successful verification
* hide failing commands

If verification fails, Forge must report it honestly.

Forge should either fix the underlying issue or explain what approval is required.

---

## LOCAL MODEL LIMITATION RULE

W3 Forge local models must be treated as useful but not fully trusted.

Forge agents must:

* inspect before editing
* verify before committing
* summarize diffs before pushing
* avoid speculative rewrites
* avoid large unreviewed changes
* prefer smaller controlled changes
* clearly report uncertainty

Local AI output is advisory until verified.

---

## COMMIT STYLE

Commits should be clean, concise, and version-aligned.

Good examples:

```text
v0.5.40: add forge rules document
v0.5.40: update admin console log layout
v0.5.40: fix release package validation message
```

Bad examples:

```text
fix
test
stuff
changes
try again
ai update
temporary
```

Forge should group related changes into as few commits as practical.

Avoid noisy experimental commits.

---

## REPORTING REQUIREMENT

After each meaningful work pass, Forge must report:

* active branch
* latest commit hash
* changed files
* summary of changes
* tests/builds run
* exact verification commands
* pass/fail result for each command
* known risks
* incomplete items
* dependencies added or proposed
* restricted categories touched or proposed
* whether branch is ready for user review

Forge may say:

```text
dev branch is ready for user review
```

Forge must not say:

```text
production ready
```

unless the user has reviewed and approved release/deployment.

---

## W3 CORE AUTHORITY RULE

For W3 Core specifically:

W3 Forge may prepare code on dev/vX.Y.Z.

W3 Core remains responsible for:

* validation
* package creation
* deployment
* backups
* restore controls
* runtime state
* operational logs
* production release workflow

Forge must never bypass W3 Core.

---

## ABSOLUTE SUMMARY

W3 Forge has controlled freedom inside the user-approved branch:

```text
dev/vX.Y.Z
```

Forge may inspect, plan, edit, test, commit, and push only within that branch.

Forge has no authority over:

* main
* production tags
* production packages
* /opt/update-packages
* /opt/update-packages/installed
* production deployment
* production databases
* live W3 Core runtime
* destructive resets
* branch deletion
* security weakening
* test weakening

The user owns the final release gate.

W3 Forge is the engineering assistant.
W3 Core is the operational authority.
The user is the release authority.

```
```
