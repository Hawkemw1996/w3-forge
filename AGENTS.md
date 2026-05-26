# AGENTS.md — Universal AI Agent Operating Rules

This document is the **universal AI-agent governance standard** for the W3
ecosystem. It applies to every AI agent that ever touches this repository,
including (but not limited to):

- Codex
- Perplexity
- future W3 Forge agents
- future internal AI workers

These rules are derived from the W3 Core Perplexity GitHub workflow and are
binding on **all agents**. Wherever historical wording said "Perplexity
must…", it is to be read as **"Agents must…" / "AI agents must…"**.

The user owns the final release gate. Agents have controlled development
freedom inside the currently active user-approved `dev/vX.Y.Z` branch and
nowhere else.

---

## 1. Next-Version Rule (Controlled Dev Freedom)

Agents must always work on the **next unreleased patch version**, not the
currently deployed version.

- The target development version is calculated from the latest deployed
  `main` release tag by incrementing `Z` in `vX.Y.Z`.
- Example: current deployed release `v0.5.14` → next agent development
  branch `dev/v0.5.15`.
- Agents must not create or continue work on a dev branch matching an
  already-deployed release tag unless the user explicitly instructs
  historical review only.
- If a version tag already exists on `main`, that version is **closed for
  development**. New work must move to the next patch version.
- Agents must not reuse an existing production tag version for new
  development, review packages, or release-candidate work.
- The user may override the next version manually. Without that override,
  agents must use `current deployed version + 1` on `Z`.

These rules apply to the W3 Core repository and to any W3 Core-related
satellite repository (including W3 Forge) unless the user explicitly
provides different repository-specific rules.

---

## 2. Required Branch Format

The only allowed development branch format is:

```
dev/vX.Y.Z
```

Examples (allowed): `dev/v0.5.14`, `dev/v0.5.15`, `dev/v0.6.0`.

Not allowed: `dev`, `development`, `agent-staging`, `perplexity-staging`,
`codex-staging`, `dev/v0.5.14-safe-wrappers`, `dev/admin-console-polish`,
`feature/v0.5.14`, `test/v0.5.14`, `perplexity/v0.5.14`, `codex/v0.5.14`,
or any branch with suffixes, feature names, test names, or staging names.

### Branch creation rule

- Agents may only create or switch to a new `dev/vX.Y.Z` branch **after
  the user has explicitly provided that exact target version number**.
- Agents must not invent version numbers.
- Agents must not create temporary, experimental, feature, staging, test,
  or scratch branches.
- The active `dev/vX.Y.Z` branch is the source of truth for unfinished
  work for that version.

### Active branch limit

- Agents may push **only the currently active matching `dev/vX.Y.Z`
  branch** and no other branch.
- Agents must not switch to a different versioned dev branch during an
  active task unless the user explicitly instructs it.
- All work for the current task must be contained in the user-approved
  `dev/vX.Y.Z` branch.

### Branch deletion rule

- Agents must **never** delete local or remote branches unless explicitly
  instructed by the user.
- Agents must not prune, remove, rename, overwrite, or otherwise destroy
  branch history unless explicitly instructed.

---

## 3. Current Working Model

For each release, the user decides the target version number. Once that
target version is known, agents may create or switch to the matching
`dev/vX.Y.Z` branch and then work freely **inside that branch only**.

Inside the active `dev/vX.Y.Z` branch, agents may:

- inspect the repository
- read files
- modify files
- create new files
- update scripts
- update frontend code
- update backend code
- update documentation
- update package metadata
- make multi-file commits
- push commits to the matching `dev/vX.Y.Z` branch
- verify the current branch state
- fix issues found during verification
- continue iterating on the same `dev/vX.Y.Z` branch until the user is
  happy with the file base

Agents must treat the current `dev/vX.Y.Z` branch as the **live working
branch** for that version.

---

## 4. Main Branch Protection

Agents must never:

- commit to `main`
- push to `main`
- merge into `main`
- rebase `main`
- reset `main`
- force-push `main`
- modify `main` in any way
- create or push release tags
- create production release packages (unless the user explicitly asks for
  a review-only package)
- place packages into `/opt/update-packages`
- move package archives into `/opt/update-packages/installed`
- run production deployment scripts
- deploy to the live W3 Core system

The **user is the only person** allowed to:

- merge `dev/vX.Y.Z` into `main`
- create release tags such as `vX.Y.Z`
- create the final production release package
- place final packages into `/opt/update-packages`
- run production deployment scripts
- deploy to the live W3 Core system

---

## 5. Restricted-Category Approval

Agents must not modify any of the following without **explicit user
approval**:

- new dependencies (additions, upgrades, or removals)
- authentication behavior
- authorization, permissions, roles, session handling, token handling,
  secrets handling, password handling, or access-control behavior
- schema changes, destructive migrations, data backfills, seed-data
  changes, or any persistent-data-impacting changes
- deployment-critical behavior, including:
  - production deployment scripts
  - backup, restore, hard-reset, and status scripts
  - systemd service behavior
  - database migration behavior
  - package install or package movement behavior
  - `/opt/update-packages` and `/opt/update-packages/installed` behavior
  - runtime environment assumptions
  - production service ports
  - reverse proxy assumptions

For restricted categories, agents must stop at:

1. analysis
2. impacted files
3. proposed commands
4. risks
5. rollback considerations
6. a recommended implementation plan

…and must **not implement** the change until the user explicitly approves
that category of change. Agents may recommend and explain, but not act.

---

## 6. Test, CI, and Verification Guardrails

Agents must not delete, disable, bypass, skip, or weaken:

- tests
- linting
- CI workflows
- verification checks
- security scanning
- required status checks
- protected-branch checks
- review requirements
- merge-gate behavior

…without explicit user approval.

Agents must not make a failing test suite appear successful by removing
tests, lowering coverage, bypassing checks, or changing verification
commands unless the user explicitly approves that exact change.

If a test, lint, build, CI, or verification check fails, agents must
report the failure honestly and either fix the underlying issue or
explain which user approval is needed.

### GitHub branch protection

Branch protection on `main` is controlled by the user. Agents may
recommend branch protection settings but must not weaken, remove, bypass,
or disable branch protection rules.

---

## 7. Final Release Process

When the user approves the current `dev/vX.Y.Z` branch, **the user**
manually:

1. Reviews the GitHub diff.
2. Merges `dev/vX.Y.Z` into `main`.
3. Creates the release tag `vX.Y.Z`.
4. Generates the final repo-shaped release package.
5. Places the package in `/opt/update-packages`.
6. Deploys using the established W3 Core deployment workflow.

Production deployment continues to use:

- `/opt/update-packages`
- `/opt/scripts/deploy-w3core.sh`
- `/opt/scripts/backup-w3core.sh`
- `/opt/scripts/status-w3core.sh`
- `/opt/update-packages/installed`

Agents may prepare code, scripts, documentation, and instructions that
**support** deployment, but agents must not perform the production
deployment itself.

---

## 8. Commit Style

- Group related changes into as few commits as practical.
- Prefer one clean release-sized commit when the change is cohesive.
- Multiple commits are acceptable when work naturally separates into
  clear parts; avoid excessive tiny commits.
- No noisy, experimental, or throwaway commits.
- Commit messages should be concise, descriptive, and version-aligned
  when practical.

Good examples:

- `v0.5.14: add admin audit logging and verification checks`
- `v0.5.14: fix recent-logs tile border layout`
- `v0.5.14: update controls registry safe wrappers`

Bad examples: `test`, `fix`, `changes`, `stuff`, `try again`,
`agent updates`, `temporary`, `experiment`.

---

## 9. Credit-Efficient Workflow Expectation

For each `dev/vX.Y.Z` branch, agents should:

- inspect the relevant files first
- understand the existing structure before editing
- avoid speculative rewrites
- avoid unnecessary back-and-forth
- make all related changes together when practical
- commit the completed changeset to `dev/vX.Y.Z`
- push only the active matching `dev/vX.Y.Z` branch
- verify the branch state before reporting back
- fix obvious issues found during verification without unnecessary
  follow-up prompts

The goal: agents handle the **read → edit → commit → verify** loop
freely inside the safe active `dev/vX.Y.Z` branch while the user retains
full control of `main`, release tags, final packages, persistent data,
and production deployment.

---

## 10. Reporting Requirement

After each meaningful work pass, agents must report:

- active branch name
- latest commit hash
- changed file list
- summary of changes
- verification / testing performed
- **exact verification commands run**
- pass / fail status of each verification command
- known risks or incomplete items
- whether any new dependencies were added or proposed
- whether any security, auth, permissions, deployment, backup, restore,
  runtime, database, schema, migration, seed-data, test, linting, CI,
  status-check, or merge-gate behavior was changed or proposed
- whether any restricted-category change was implemented, proposed only,
  or not touched
- whether the branch is ready for user review

Examples of verification reporting:

- `npm test — passed`
- `npm run build — passed`
- `pytest tests/api — failed (missing fixture)`
- `./scripts/status-w3core.sh — passed`

Agents must not claim production readiness. Agents may say the dev branch
is "ready for user review", but only the user decides whether it is ready
to merge, package, tag, or deploy.

---

## 11. Absolute Summary

- Agents have freedom **inside** the currently active user-approved
  `dev/vX.Y.Z` branch.
- Agents may push **only** that active matching `dev/vX.Y.Z` branch.
- Agents may not delete branches unless explicitly instructed.
- Agents may not add dependencies or modify security, auth, permissions,
  deployment, database, schema, persistent-data, test, CI, status-check,
  or merge-gate behavior without explicit user approval.
- For restricted categories, agents must stop at analysis, impacted
  files, proposed commands, risks, rollback considerations, and a
  recommended implementation plan until the user explicitly approves
  implementation.
- Agents have **no authority** over:
  - `main`
  - other `dev/vX.Y.Z` branches (unless explicitly instructed)
  - release tags
  - production packages
  - `/opt/update-packages`
  - `/opt/update-packages/installed`
  - persistent production data
  - production deployment
  - the live W3 Core runtime
- **The user owns the final release gate.**

---

# W3 Ecosystem Architecture

The W3 ecosystem is built on a clear separation of concerns between three
layers. Agents must respect this separation in everything they propose
and implement.

## W3 Core

- **Source of truth** for the W3 ecosystem.
- Business / knowledge database (shared users, entities, projects,
  properties, tasks, alerts, documents, and links to connected W3 apps
  such as CleanBooksAI, BuildCost, ForeclosurePro, n8n).
- **Operational authority** — runs the live operational system.
- **Deployment authority** — the canonical production deployment target.
- **Universal admin console standard** — the W3 Core admin console UI/UX
  defines the universal admin-console pattern that other W3 apps inherit.

## W3 Forge

- **Engineering system** for the W3 ecosystem.
- Validation / review / workflow engine.
- **Modular app-admin control layer** — provides the reusable controls
  and execution primitives that app admin consoles plug into.
- **Safe execution environment** — runs scripts and workflows under the
  W3 Forge safety contract (e.g. `safeRunner`, `shell:false`, structured
  `ApiEnvelope<T>` responses).

## Chat Workspace

- **AI engineering workspace** — where Codex, Perplexity, and other AI
  agents plan, discuss, and write code.
- Planning / discussion / coding environment for AI-assisted development.
- **Separate** from the operational admin console. The chat workspace
  must never act as the live admin console for W3 Core or W3 Forge.

## Inheritance Model

- The **W3 Core Admin Console UI/UX** is the universal admin-console
  standard.
- The **W3 Forge backend / control architecture** is the modular
  execution engine.
- Future W3 apps inherit:
  - shared admin UI patterns (from W3 Core)
  - app-specific config (under `config/apps/<app-name>/`)
  - app-specific controls
  - app-specific authority levels

Agents must not redesign the W3 Core admin console UI/UX. New app admin
consoles must follow the established W3 Core look-and-feel and plug into
the W3 Forge control layer.

---

# Codex Operational Guidance

The following guidance is specifically for Codex (and is a strong default
for any other agent operating in this repository). It does **not**
override the universal rules above — it adds operational expectations on
top of them.

- **Prefer worktree mode when editing.** Use a git worktree on the active
  `dev/vX.Y.Z` branch instead of mutating the main checkout.
- **Keep work scoped to one repo / one project per pass.** Do not
  cross-edit unrelated repositories or directories in the same pass.
- **Never bypass `AGENTS.md` rules.** `AGENTS.md` is the universal
  governance contract. Agents must not silently override, "improve", or
  reinterpret it.
- **Preserve existing W3 Core admin console look-and-feel.** Do not
  redesign, rename, or restructure the W3 Core admin console UI unless
  the user explicitly approves a redesign.
- **Prefer modular, config-driven architecture.** New behavior should be
  expressed as configuration plus reusable controls, not hard-coded
  branches.
- **Use app configs under `config/apps/`.** Per-app behavior in W3 Forge
  (and any inheriting W3 app) belongs in `config/apps/<app-name>/`.
- **Avoid hardcoded paths.** Use the `W3_FORGE_ROOT` variable pattern
  (and analogous variables for W3 Core) instead of literal absolute
  paths.
- **Preserve the `ApiEnvelope<T>` contract.** All control / API
  responses must continue to use the `ApiEnvelope<T>` shape. Do not
  invent ad-hoc response shapes.
- **Preserve `safeRunner` restrictions.** Do not bypass `safeRunner` or
  invent unrestricted execution paths. New executable behavior must run
  through the existing safe-execution layer.
- **Preserve the `shell:false` execution model.** Never reintroduce
  `shell:true` or unstructured shell interpolation for control execution.
  Pass arguments as arrays, not as concatenated strings.

If a change appears to require violating any of the above, the agent
must stop, document the impacted files and risks, propose a plan, and
wait for explicit user approval per Section 5.
