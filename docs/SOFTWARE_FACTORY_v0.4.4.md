# W3 Forge Software Factory — v0.4.4

W3 Forge organizes software requests by project, keeps the rules used for each request, and tracks work through planning, development, testing, and review. The engineering workspace uses the shared W3 sidebar, theme, and page layout.

## Projects, rules, and requests

Each project has rules documents with immutable versions. A request pins the rules revisions used in its prompts, so later rule edits do not silently change an existing request's instructions. Prompts retain the project rules and request context for review.

Requests follow FIFO order within their project. The workflow is:

`queued → planning → approval → development → testing → review → update_ready`

Approval and recorded stage transitions provide the process controls. Administrators can record and attest development commits, test results, and a package SHA. Those records are manual attestations; Forge does not independently verify the referenced commits, test execution, or package contents.

## AI services and test environments

Ollama can draft a plan using an installed local model and the project's pinned rules. Plan drafts still require review and approval. Other worker adapters are not configured in this release, and Forge does not autonomously code, run a development worker, or deploy an update.

The service dashboard distinguishes installed Ollama models, observed Codex test environments, unavailable observations, and unconfigured adapters. Perplexity, Grok, and Claude remain unconfigured until protected server-side adapters are implemented. A running labelled Codex test container establishes an observed test environment; it does not establish a connected coding agent or a passing test result.

Test-environment and service observations are live and read-only. Hardware lists the CPU model and logical processors, available and total memory, OS/kernel/architecture/uptime, root filesystem capacity, block-device models and sizes, and NVIDIA GPU/VRAM/driver when available. These measurements describe the Forge VM, not its Proxmox host. Unavailable observations stay visible with their unavailable status.

## Updates and visibility

Workflow updates create durable in-app notifications for the relevant user. The notification feed returns only that user's notifications. This release does not send external messages or email.

The workspace snapshot contains up to 200 projects, 200 requests, 100 runs, and 100 notifications belonging to the current user. Summary metrics are calculated across the stored rows rather than inferred from these limited lists.

## Database, authorization, and deployment

Migration `002` adds the Software Factory data structures. Existing migration `001` is unchanged. Existing Core authentication, current app-admin authorization, and same-origin mutation checks remain in force. No dependencies are added.

The source and deployment pipeline apply migrations through the owner's deployment process. Preparing this release does not automatically deploy to production.

An application rollback uses the previous application package through the owner's normal rollback process. Preserve the migration `002` data when rolling back the application. No destructive down migration is supplied.

## Validation

Run the integrated checks from the repository root:

```bash
npm run typecheck && npm test && npm run build && npm run console:verify
```

The complete gate passed in an isolated non-root Node 22.23.3 container: 402 tests passed (248 backend, 110 frontend, 28 operator-script, 12 console-integration, and 4 Test Dev integration tests). Typechecking, production builds, console parity, and all 120 pinned shared-console files passed verification at v0.3.1 revision `468e628ffaf43827c452d60371a8201c0125d3d8`.

A separate Chrome workflow passed project creation, immutable rules v1/v2 prompt pinning, request intake, plan drafting, approvals, development/test/review receipts, update-ready notifications, hardware and service views, assistant draft persistence, and mobile navigation/focus/overflow checks with no page errors. Browser identity, hardware, containers, and model output were isolated fixtures; the workflow API used the real factory service and migrations in a disposable PGlite database. Native hardware discovery was also checked read-only as forgeadmin on the Forge VM.

No live application restart, deployment, or production migration was performed.

## API surface

All endpoints retain the existing app-admin and same-origin boundary and return the standard API envelope.

- `/api/forge/factory`: current snapshot, projects, immutable rules revisions, requests, pinned prompts, explicit actions, local plan drafts, and own notification read state.
- `/api/forge/environments`: registered Codex test containers and sanitized pipeline progress.
- `/api/forge/services`: independently observed AI/service capabilities and configuration status.
- `/api/forge/hardware`: read-only hardware inventory with observation time and independent unavailable states.

The factory requires migration `002_software_factory.sql` through the existing migration runner. Before an owner deploy, use the existing package verification and mandatory backup workflow. An old application package can coexist with the retained additive factory tables; do not edit released migration checksums or delete the factory data during an application rollback.

## Protected release permissions

Release archives are built on Linux with explicit `tar.umask=0022` and protected staging permissions. This applies even when the caller or Git configuration permits group writes. Generated console files keep their verified contents while group/other write bits are removed from their staging copies. The caller umask and source files remain unchanged. Windows archive creation refuses before writing output because Windows can replace Unix archive modes.

The Test Dev policy continues to require protected root ownership and no group/other write bits on the deployed YAML parser and every parent. On the inspected v0.4.3 host, only `/opt/w3forge` failed: it was `root:root` mode `0775`. The owner can correct that exact directory with `chmod g-w -- /opt/w3forge`, then retry Test Dev. No recursive ownership change, policy bypass, application restart, or database operation is needed. Historical packages and backups keep their original modes; this correction applies to newly prepared v0.4.4 packages.

## Shared W3 product layout

The engineering workspace uses the same shared sidebar shell as W3 Books and W3 BuildCost: a 240px desktop rail, the standard mobile drawer, shared branding/navigation/footer components, and runtime-derived version/environment badges. Only Forge branding and navigation items differ. Page content uses BuildCost typography and spacing: the same Inter/system sans stack, 20px page headings, 14px body content, 13px tables and controls, and shared card surfaces. Factory-specific styles are scoped to the main content so they cannot recolor navigation links or resize the shared footer. The owner packages and deploys this update from dev/v0.4.4.

The sidebar/typography refinement passed browser checks against the final production assets for canonical navigation colors, page/card/table/control text sizes, shared footer styling, 240px desktop/tablet rail, 288px/85vw mobile drawer, Escape/focus restoration, and unavailable runtime metadata. The full project/request/rules/approval/test/review/notification workflow also passed with no page errors in the isolated fixture.
