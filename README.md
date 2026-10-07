# W3 Forge

W3 Forge is the local AI-assisted engineering system for W3 applications.

It is responsible for inspection, planning, development-branch edits, testing, diff summaries, commits, and approved dev-branch pushes.

W3 Forge does not deploy production, push main, merge main, create release tags, or modify production data.

## Current Version

v0.4.1 — Core app access, GitHub connections and interactive admin terminal (unreleased, `dev/v0.4.1`)


See [Core connection and console parity](docs/CORE_CONNECTION_v0.4.1.md) for required configuration and owner pairing. Sign-in now requires Core v0.12.16 and a Forge app admin assignment.

Development checks: `npm ci --prefix backend`, `npm ci --prefix frontend/admin`, `npm run build --prefix backend`, `npm test --prefix backend`, `npm run typecheck --prefix frontend/admin`, `npm run build --prefix frontend/admin`, and `npm test --prefix frontend/admin`. Backend script execution checks require Linux/Bash. The existing launcher remains `scripts/w3-admin-console.sh`.

Optional, default-disabled manual supplier research: [Material pricing service](docs/MATERIAL_PRICING.md). Forge collects bounded observations and local-model recommendations; BuildCost owns confirmed mappings and accepted cost history. This explicitly scoped paid HTTP workflow is separate from read-only admin controls.

See [Forge application foundation](docs/APP_FOUNDATION_v0.4.1.md) for connections, terminal controls, the optional service template, live host findings and owner activation/rollback steps.
