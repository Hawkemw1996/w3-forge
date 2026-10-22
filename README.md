# W3 Forge

W3 Forge is the local AI-assisted engineering system for W3 applications.

It is responsible for inspection, planning, development-branch edits, testing, diff summaries, commits, and approved dev-branch pushes.

Forge’s engineering agents stay inside approved development branches. The shared Admin Console exposes the same owner-operated release, deployment, backup and recovery workflows as BuildCost, with the same confirmations and release gates.

## Current Version

v0.4.7 — durable profile-driven factory execution with specification approval, isolated checks and bounded corrections (unreleased, dev/v0.4.7)

See [factory execution and operator activation](docs/factory-execution.md), [agent profiles and model assignments](docs/AGENT_PROFILES_v0.4.6.md) and [AI connections and verification](docs/AI_CONNECTIONS_v0.4.5.md).

Open `/forge/` for chat and test environments, or `/admin/` for operations. See [workspace configuration and test registration](docs/FORGE_WORKSPACE_v0.4.3.md).

The standard unit is `w3forge.service`, using the owner-approved root operational model. Existing `w3forge-admin.service` installations require the [service transition](docs/SERVICE_STANDARD_v0.4.2.md).


See [Core connection and console parity](docs/CORE_CONNECTION_v0.4.1.md) for required configuration and owner pairing. Sign-in now requires Core v0.12.16 and a Forge app admin assignment.

Development checks from the repository root: `npm ci`, `npm run typecheck`, `npm run build`, and `npm test`. Backend script execution checks require Linux/Bash. The launcher remains `scripts/w3-admin-console.sh`.

Optional, default-disabled manual supplier research: [Material pricing service](docs/MATERIAL_PRICING.md). Forge collects bounded observations and local-model recommendations; BuildCost owns confirmed mappings and accepted cost history. This explicitly scoped paid HTTP workflow is separate from the shared admin console.

See [Forge application foundation](docs/APP_FOUNDATION_v0.4.1.md) for connections, terminal controls, the optional service template, live host findings and owner activation/rollback steps.

See [full admin parity and installation](docs/ADMIN_CONSOLE_PARITY.md) for scope, verification, host prerequisites, service migration and rollback. The frontend source manifest is `frontend/admin/console-provenance.json`.
