# W3 Forge — Codebase Map (Starter)

> **Status:** Starter placeholder. This document is intentionally not a
> full mapping of the repository yet. It establishes the structure and
> the agreed sections; deep mapping will be filled in over future passes.

## Purpose

The Codebase Map is the canonical "you are here" document for agents and
humans working in W3 Forge. It is intended to answer, at a glance:

- where each subsystem lives in the repo
- which areas are safe for routine edits vs restricted
- which patterns and contracts must be preserved (e.g. `ApiEnvelope<T>`,
  `safeRunner`, `shell:false`)
- which areas are planned modularization targets

This file complements (it does **not** replace):

- [`AGENTS.md`](../AGENTS.md) — universal AI-agent operating rules
- [`docs/FORGE_RULES.md`](./FORGE_RULES.md) — Forge-specific rules
- [`docs/APP_ADMIN_STANDARD.md`](./APP_ADMIN_STANDARD.md) — app admin
  console standard

## Frontend Structure

Top-level: `frontend/`

- `frontend/admin/` — the W3 Forge admin console scaffold and any
  app-admin surfaces hosted in Forge.

W3 Forge's admin surfaces inherit the **universal admin-console UI/UX
standard** defined by W3 Core. Forge contributes the underlying
**control layer** and execution primitives.

> **TODO (deep map):** enumerate admin pages, app-admin surfaces, shared
> components, and the contract between Forge admin UI and the controls
> registry. Cross-reference `docs/APP_ADMIN_STANDARD.md`.

## Backend Structure

Top-level: `backend/`

- `backend/src/` — backend TypeScript source (controls, services,
  workflows, validation, runners).
- `backend/test/` — backend tests.
- `backend/vitest.config.ts` — test runner configuration.
- `backend/tsconfig.json` — backend TypeScript configuration.
- `backend/package.json` / `package-lock.json` — backend package
  metadata.

> **TODO (deep map):** enumerate the controls registry, `safeRunner`
> implementation, `ApiEnvelope<T>` usage, `shell:false` execution paths,
> validation utilities, workflow engine entry points, and the boundary
> between Forge core and per-app code.

## Admin Console Structure

W3 Forge's admin surfaces follow the **W3 Core admin console UI/UX
standard**. Forge does not redefine the admin look-and-feel; it provides
the modular execution engine that admin consoles plug into.

> **TODO (deep map):** document the shared admin-console contract
> between W3 Core (UI standard) and W3 Forge (control layer): how Forge
> exposes controls, how admin consoles consume them, and which extension
> points are stable.

## Controls System

The controls system is W3 Forge's core contribution to the ecosystem. It
provides:

- a registry of controls (operations the admin console can invoke)
- safe execution via `safeRunner` (argv-array, `shell:false`)
- structured `ApiEnvelope<T>` responses
- per-app authority and configuration boundaries

> **TODO (deep map):** enumerate the controls registry, control
> categories, input validation rules, audit logging, error envelope
> shape, and the rules for adding a new control. Document how controls
> map to scripts under `scripts/` and to per-app config under
> `config/apps/`.

## Scripts

Top-level: `scripts/`

Operational shell scripts for app inspection, validation, review, status
reporting, and workflow checks. Examples: `w3-admin-console.sh`,
`w3-app-branch-check.sh`, `w3-app-config-validate.sh`,
`w3-app-diff-summary.sh`, `w3-app-git-status.sh`, `w3-app-inspect.sh`,
`w3-app-local-model-test.sh`, `w3-app-review-ready.sh`,
`w3-app-review-report.sh`, `w3-app-status.sh`, `w3-app-test.sh`,
`w3-app-workflow-status.sh`.

> **TODO (deep map):** group scripts by purpose (inspection, validation,
> review, status, workflow), mark which are invoked by controls vs by
> humans, and capture the `W3_FORGE_ROOT` variable pattern and other
> path conventions. Mark any script with persistent-data, systemd, or
> deployment coupling as **restricted**.

## Workflows

W3 Forge's validation, review, and workflow engine.

> **TODO (deep map):** enumerate workflow definitions, state machines,
> review-readiness checks, and the integration points with W3 Core's
> release pipeline. Document GitHub Actions workflows and required
> status checks.

## Protected Areas

Areas that agents must not modify without **explicit user approval**
(see `AGENTS.md` §4 and §5):

- `main` branch (no commits, pushes, merges, rebases, resets, or
  force-pushes)
- release tag creation
- production release packages and any equivalent of
  `/opt/update-packages` / `/opt/update-packages/installed`
- production deployment scripts and any deploy-critical behavior
- backup, restore, hard-reset, and status scripts
- systemd service behavior and reverse proxy assumptions
- authentication, authorization, permissions, roles, sessions, tokens,
  secrets, and access-control behavior
- schema changes, destructive migrations, data backfills, seed-data
  changes, and any persistent-data-impacting changes
- CI workflows, required status checks, protected-branch rules, review
  requirements, and merge-gate behavior
- dependency additions / upgrades / removals (`package.json` /
  `package-lock.json` changes that affect installed deps)
- the `safeRunner` contract, `shell:false` execution model, and
  `ApiEnvelope<T>` response shape — these are **architectural
  invariants** and must not be weakened, bypassed, or replaced without
  explicit user approval

For each, agents must follow the **propose-only** workflow in
`AGENTS.md` §5.

## Future Modularization Targets

Candidate areas for future modularization (to be planned and approved
per restricted-category rules where applicable):

- per-app config conventions under `config/apps/<app-name>/`
- shared control primitives reusable across W3 Core, W3 Forge, and
  future W3 apps
- a published "app admin standard" describing how new W3 apps plug into
  the Forge control layer and inherit the W3 Core admin UI
- standardized review-readiness reports across W3 apps

> **TODO (deep map):** for each target, capture current coupling, the
> proposed module boundary, migration steps, risks, and rollback plan.
> No restricted-category work is implemented until explicitly approved.

---

_This file is a starter placeholder created as part of the universal
AI-agent governance documentation pass. Deeper mapping will be filled in
on a future approved `dev/vX.Y.Z` branch._
