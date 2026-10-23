# W3 Forge v0.4.8 development review

Target branch: **dev/v0.4.8**. Base: **4e7f2f1fbcb12bc7682bc964350e7790dde15066** (the verified v0.4.7 development head). Prepared October 22, 2026, America/Chicago.

This change implements Context Gateway views, persistent agent execution metrics, independently versioned execution settings, and complete execution records in the existing Forge application. It does not deploy or publish a production release. The live VM's deployed bytes were not inspected during this task; v0.4.7 deployment is the user-provided starting state.

## Repository findings

- The default GitHub branch is historical dev/v0.1.0. The newest development branch at inspection was dev/v0.4.7; the local clean checkout matched its full GitHub SHA.
- Existing PostgreSQL tables already provided immutable Markdown profiles, independent provider assignments, frozen job contexts, a single durable worker slot, approval gates and four independent reviews.
- The existing worker fixed the supported roles and providers. This change extends its ports, store and broker rather than replacing them.
- Provider calls previously produced only small model-selection events. There was no durable per-call usage or cost ledger.
- Test output was previously reduced to a sanitized 12,000-character tail. The original captured streams now have their own append-only records.
- Existing W3 sidebar, shared components, authentication, same-origin checks, provider isolation, container restrictions and shared-console pin are retained.

## Third-party evaluation

| Repository / immutable revision | Findings | Decision |
| --- | --- | --- |
| [ctx](https://github.com/slavakurilyak/ctx/tree/28f09c0415019fb5e4e9fab17ff79df1d30f087d) | Go CLI wraps execution output with token counts, duration and exit metadata. Its manifest requires Go 1.24.4, tokenizer, Vertex AI and OpenTelemetry packages. Telemetry includes command text, host and user metadata and has an enabled-by-default initialization path. README's MIT badge does not describe the whole [license](https://github.com/slavakurilyak/ctx/blob/28f09c0415019fb5e4e9fab17ff79df1d30f087d/LICENSE): commercial dashboard, analytics, accounts and cloud features are excluded. Its tokenizer mapping also treats Claude as a GPT encoding, which is an estimate rather than authoritative provider billing. | Reuse the envelope/measure-before-send ideas through native TypeScript. No code, binary, telemetry, cloud service or dependency imported. No adoption of the README's cost-reduction claims. |
| [AgentX](https://github.com/slavakurilyak/agentx/tree/3cbfdf8afb8462bad17235eb0b0f07b6997fae22) | MIT-licensed archived Python experiment, last pushed in 2023. Uses Python <3.12, LangChain 0.0.144, OpenAI 0.27, FAISS and other older dependencies. BabyAGI's iteration maximum is optional; task retrieval/delegation is an architectural idea, not a sandbox or permission system. | No framework installation or code import. Preserve Forge's deterministic approvals, finite context requests, two-correction limit and isolated execution. |
| [awesome-ai-agents](https://github.com/slavakurilyak/awesome-ai-agents/tree/a32e86f60db8dd9556218403532264e0794822c4) | MIT resource catalog and Go-based catalog maintenance tooling. Useful classifications include evaluation, observability, guardrails, structured output, tools and local inference. Listed resources have their own licenses and security properties; catalog inclusion is not verification. | Keep the seven existing unique profiles. Expand the new-profile Markdown scaffold for supported tasks, governance, output format and validation. Versioned settings and freeform profiles can support future specialists without importing a catalog or changing today's fixed worker roles. |

This is a static source/license/dependency review, not a vulnerability audit of the external dependency graphs. No third-party code was copied.

## Implemented behavior

### Context Gateway

- Full retains the original tool text. Structured adds normalized metadata and a complete-record reference.
- Compact deduplicates recognized successful progress/blank noise. Summary removes recognized successful progress noise while preserving ordinary output.
- Warning/error/security lines and their neighboring diagnostics are retained. Failed command output is not reduced.
- Source, diffs, profiles, rules, acceptance criteria and structured agent answers are never summarized away.
- Processing produces a derived view; original records remain immutable. Display and transmitted-context redaction do not mutate originals.
- A configurable estimated input-token budget and the existing byte limit are checked before a provider launch. An over-budget original is retained and the job blocks with CONTEXT_BUDGET_EXCEEDED.
- Estimates use the disclosed UTF-8-bytes/4 heuristic. This is not a tokenizer or a guarantee of fit in a model's actual context window.
- Complete test streams, including early failures missing from the old tail preview, are fed through the selected agent's mode before review/correction handoff.

### Settings and profiles

Settings have independent immutable revisions, optimistic concurrency, audit events and per-job snapshots. The controls cover context mode, budget, timeout, provider retries, file-context request limit, the existing read_files permission, and optional model-specific pricing.

Profile edits still create Markdown revisions. Provider reassignment does not rewrite Markdown or settings. New jobs freeze profile version/checksum, assignment revision and settings revision; older frozen contexts retain historical defaults.

Specification approval, required reviews, release approval, protected paths, native-tool denial and the existing two-correction limit remain enforced by code. Markdown grants no permissions. The file-tool setting can only narrow the existing capability.

### Metrics and evidence

Each actual provider attempt has its own durable execution ID, job/task/project IDs, agent identity, exact profile and settings revisions, requested/resolved model, timestamps, duration, status and retry count.

Input and output token sources are separate: provider, estimated or unavailable. Known zero remains zero. Missing output stays null, and a failed attempt does not invent a zero-token response. Completed observations and original records cannot be updated or deleted.

Ollama terminal usage and Codex/Claude CLI usage are captured where available. CLI default-model resolution remains unavailable when it is not reported. Costs require configured matching provider/model rates, provider-reported input/output counts and compatible cache accounting. Cached cloud usage without supported rates remains unpriced.

The dashboard shows execution totals, successes, failures, running/cancelled calls, known token totals, average duration, estimated costs and original/sent context estimates. Agents adds project/agent/provider/date filters, provider/project breakdowns, paginated history and complete-record viewing/downloads. Date endpoints use inclusive start and exclusive end; the UI's “Through date” includes the selected local calendar day.

The execution panel provides original input, sent context, provider output and command-log records independently of small event previews. Recognized sensitive values and terminal formatting are redacted on read. Raw authoritative records stay within the existing protected PostgreSQL boundary.

## Migration and rollback

New file: database/migrations/005_agent_observability.sql.

- Adds factory_agent_execution_settings, factory_execution_records and factory_agent_executions.
- Adds a defaulted execution_revision pointer and deferred foreign key to factory_agents.
- Seeds default execution settings for existing identities without altering Markdown, profile versions, assignments or existing job contexts.
- Installs append-only/terminal-observation guards and filter indexes.
- A compatibility trigger gives default settings to agents created by the previous application writer after rollback. Custom settings at creation receive their own next revision.
- The existing checksum-ledger runner remains unchanged. Reapplication is a no-op; released migrations 001–004 are unchanged.
- Migration behavior was exercised only in disposable PGlite databases, including the old writer's INSERT pattern. No live schema or data was changed.

Owner deployment should use the existing pipeline and a verified backup. Apply the additive migration through that pipeline. For application rollback, stop active workers through the established procedure, use the approved prior application package, and retain these additive tables and all evidence. Do not reverse/drop tables or restore a database merely to remove this feature. A live PostgreSQL 16 migration/rollback rehearsal remains an operator acceptance item.

## Security and reliability

Existing Core admin and same-origin middleware protects all new endpoints. Tests cover anonymous, viewer, revoked and foreign-origin access before storage. IDs, filters, dates and settings are validated; SQL uses bound values. Record text is rendered as text, never HTML.

The worker retains lease checks, cancellation fencing, cleanup verification, fixed broker operations and credential-free test containers. Provider retries are bounded at two and require confirmed cleanup. A per-call deadline cannot extend the protected broker's host timeout. Worker interruption closes outstanding observations as interrupted.

No dependency was added, removed or upgraded. Package/lock changes are app-version metadata only. No Core repository, shared-console source/pin, authentication policy, production configuration, deployment/backup/restore script, release tag or merge gate was changed.

Record storage intentionally retains originals, with per-record bounds and a finite execution loop. Storage growth needs owner retention/backup planning. Redaction recognizes common secrets; credential-free inputs and existing source protections remain required. This feature does not make arbitrary repository text safe or authorize live credentials.

## Validation

Exact repository commands and outcomes:

| Command | Result |
| --- | --- |
| npm ci --no-audit --no-fund | Passed; locked application dependencies installed. Local npm tooling was supplied externally. |
| npm run typecheck | Passed. |
| npm run build | Passed; existing backend and frontend build paths. |
| npm test | Windows run: backend 309 passed, 2 failed; frontend 117 passed. The remaining failures are unchanged safeRunner Bash stub launches returning spawn EFTYPE on Windows. The migration readiness expectation was corrected to 005; an earlier transient Windows cleanup race passed on rerun. Because the workspace aggregate fails, later root-script checks remain a Linux CI gate. |
| npm exec --workspace backend -- vitest run test/contextGateway.test.ts test/agentObservability.test.ts | Initial focused run passed; the final aggregate also includes the added rollback-writer and nested-redaction coverage. |
| npm exec --workspace backend -- vitest run test/observabilityRoutes.test.ts test/observabilityEngine.test.ts | Passed; final aggregate includes real deadline, bounded retry, denial and over-budget evidence coverage. |
| node --test tests/agentMetrics.test.mjs (frontend/admin) | 4 passed. Included in the 117 frontend tests. |
| node scripts/browser-agent-observability.cjs <external-playwright-module> <chrome-binary> | Passed against the built application with synthetic API fixtures: 1440×1000 and 390×844. Settings save, provider separation, stale-edit recovery, filters, output download, escaped text, mobile overflow, drawer, failed refresh, empty state and dashboard checked. |
| node scripts/benchmark-context.cjs | Passed; all required evidence markers retained. |
| git diff --check | Passed. |

No test was removed or skipped to obtain a pass. The Windows Bash failures are reported rather than weakening shell:false. Linux CI on the exact development commit must pass the existing full workflow, including console verification, parity and native script tests, before release acceptance.

Internal browser screenshots and full local logs are retained in ignored cache files. They use synthetic data and are not release artifacts.

## Benchmark results

See CONTEXT_GATEWAY_BENCHMARK_v0.4.8.json for exact measured values, hardware, runtime and all modes. The harness warms each mode 20 times and samples it 200 times.

| Workload | Compact estimated-token change | Evidence retention |
| --- | --- | --- |
| Successful dependency progress | 99.50% reduction | All required markers retained |
| Failed checks, early diagnostic and stack | 4.20% increase from metadata | Entire failed output retained |
| Source code / candidate diff | 5.35% increase from metadata | Entire source/diff retained |
| Successful Unicode output with warning | 98.92% reduction | Warning and diagnostic markers retained |

These are deliberately noisy synthetic workloads. Local per-view processing p95 stayed below 0.32 ms in this run. This does not measure end-to-end provider latency, billing, model quality or actual Qwen tokenization. Ordinary meaningful output may grow because of metadata. No universal efficiency claim is made.

## Limitations and review readiness

Implemented: gateway modes/budgets, original records, settings revisions/snapshots, usage sources, bounded retries/deadlines, interruption reconciliation, filtered metrics and existing-interface integration.

Remaining acceptance: exact-commit Linux CI; operator-controlled migration/rollback rehearsal; a real installed Codex/Claude/Ollama smoke run through the existing protected Forge runtime. Browser verification uses the real built frontend and synthetic APIs; it is not live-provider or production verification. No new provider/framework was installed.

The existing worker still dispatches the seven established roles. The profile catalog is extensible for future roles, but this change does not invent dynamic role dispatch or new provider adapters. Historic calls are not backfilled with invented metrics. Output limits can stop execution; interrupted providers may have partial or unavailable output. Summary is deliberately deterministic and conservative, not a second summarizing LLM.

The development changes are prepared for owner review. Production release acceptance remains conditional on the existing full checks and operator prerequisites. No production package, tag, main merge, credential rotation, server provisioning, live migration or deployment occurred.

## Files changed

- .gitignore
- CHANGELOG.md
- VERSION
- backend/package-lock.json
- backend/package.json
- backend/src/agents/routes.ts
- backend/src/agents/service.ts
- backend/src/agents/settings.ts
- backend/src/agents/types.ts
- backend/src/execution/contextGateway.ts
- backend/src/execution/engine.ts
- backend/src/execution/metrics.ts
- backend/src/execution/providers.ts
- backend/src/execution/routes.ts
- backend/src/execution/runtime.ts
- backend/src/execution/store.ts
- backend/src/execution/types.ts
- backend/src/workspace/ollama.ts
- backend/test/agentObservability.test.ts
- backend/test/consoleReadiness.test.ts
- backend/test/contextGateway.test.ts
- backend/test/observabilityEngine.test.ts
- backend/test/observabilityRoutes.test.ts
- database/migrations/005_agent_observability.sql
- docs/CONTEXT_GATEWAY_BENCHMARK_v0.4.8.json
- docs/DEVELOPMENT_REVIEW_v0.4.8.md
- frontend/admin/package.json
- frontend/admin/src/workspace/AgentExecutionSettings.tsx
- frontend/admin/src/workspace/AgentMetrics.tsx
- frontend/admin/src/workspace/Agents.tsx
- frontend/admin/src/workspace/ExecutionPanel.tsx
- frontend/admin/src/workspace/ExecutionRecords.tsx
- frontend/admin/src/workspace/FactoryWorkspace.tsx
- frontend/admin/src/workspace/agent-metrics.css
- frontend/admin/tests/agentMetrics.test.mjs
- package-lock.json
- package.json
- scripts/benchmark-context.cjs
- scripts/browser-agent-observability.cjs
