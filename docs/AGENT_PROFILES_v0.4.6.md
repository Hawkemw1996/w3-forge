# Agent profiles — v0.4.6

## Owner-approved scope

The factory sidebar now separates **Agents** (role instructions and model assignments) from **AI Connections** (provider availability, sign-in checks and manual connection tests). This release provides configuration management. It does not dispatch coding workers, execute profile instructions, merge changes or deploy applications.

## Initial profiles

Seven complete provider-independent Markdown profiles start at profile version 0.1.0:

| ID | Role |
| --- | --- |
| orchestrator | Coordinates tasks, dependencies, handoffs, review rounds, version decisions within project rules, and escalation. |
| specification-writer | Produces repository-grounded requirements, acceptance criteria, assumptions and scope boundaries. |
| developer | Implements scoped changes, verifies acceptance criteria and responds to review findings. |
| code-reviewer | Independently checks correctness, error paths, maintainability and repository conventions. |
| security-reviewer | Reviews access control, input handling, secrets, dependencies and execution boundaries. |
| ui-reviewer | Checks theme consistency, responsive layout, typography, spacing and visible states. |
| ux-reviewer | Checks complete user flows, actionable feedback, accessibility and keyboard navigation. |

The source profiles live in config/agents/. Each includes purpose, responsibilities, inputs, working instructions, outputs, completion criteria and escalation rules. Initial deployment populates the saved profiles through the additive migration. The saved database revision is authoritative for subsequent edits; changing a template file does not overwrite operator edits.

## Using Agents

Open an agent to inspect its profile, edit Markdown, preview it safely, inspect prior revisions or download the selected revision as a Markdown file. Create and duplicate produce separate agent identities. Enable/disable controls whether a profile is available for future assignment; it does not imply a worker is running.

Profile versions and Forge application versions are independent. A newly created profile starts at 0.1.0. Saving changed profile instructions creates a new immutable revision. Saving provider/model settings leaves the profile revision unchanged. Concurrent updates are rejected instead of overwriting another editor's saved changes.

Deletion removes an agent from the active list while retaining its saved revision history. Existing records must remain attributable to their original profile. This release does not attach profiles to the pre-existing manually reported factory run receipts or claim those receipts came from configured agents.

## Models and connections

Choose the provider and model separately from the Markdown. Local model choices come from Forge's installed Ollama inventory. A provider-default selection delegates model choice to the existing provider client; an explicit remote model identifier must be supported by that account. Saving an assignment is configuration only and does not verify account/model access. Use AI Connections for the existing manual connectivity checks.

A profile cannot grant filesystem, shell, network, credential, production or release permissions. A future worker adapter must enforce its own permission boundary and record the exact effective model, profile revision and source revision used by each run. Markdown is treated as text, with raw HTML and script content excluded from rendered preview execution.

## Verification

Run from the repository root in an isolated Linux development environment:

- npm ci
- npm run typecheck
- npm test
- npm run build
- npm run console:verify

Backend checks cover migration and initial data, retained revisions, independent assignment changes, concurrent updates, invalid inputs, access guards and deletion behavior. Browser checks cover populated profiles, editor/preview/history flows, model settings, separate connections, and desktop/mobile layout.

## Deployment and rollback

Deploy through the existing owner-operated Admin Console pipeline. The new forward migration adds profile tables and initial data without rewriting existing factory requests or released migrations. The pipeline applies pending migrations under its existing migration ledger rules; do not run them manually against production as part of development verification.

If the application update must be rolled back, restore the prior application through the established pipeline and retain the added tables and agent data. Do not run a destructive down migration or delete profile history. Reopening v0.4.6 must preserve operator edits, assignments and deletion state. The shared console pin, provider credential handling and release gates remain unchanged.

## Development verification record

Validated in a disposable Linux container as uid/gid 1000:1000 with Node 22.23.3. npm ci, npm run typecheck, npm test (426 passing tests), npm run build, and npm run console:verify passed. After accessible-label refinements, the frontend typecheck and build plus console verification passed again. The production-built browser fixture passed desktop and 390px mobile checks for all seven populated profiles, safe preview, editing/history/download, independent assignments, conflict recovery, unsaved navigation, create/duplicate/enable/delete, and provider test controls. Provider responses in browser checks were fixtures; no live generation or production database operation was performed.
