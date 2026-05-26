// =============================================================================
// W3 Forge controls registry — v0.4.0.
// =============================================================================
//
// Source of truth for which scripts the Admin Console may run. Every entry
// is LOW risk, safe-direct, read-only, and always invoked with --app <appId>.
//
// The registry deliberately omits:
//   - deploy / release / package promote / package install
//   - backup create / backup restore
//   - patch apply / hardreset
//   - any operation that touches production data, /opt/update-packages,
//     or branches matching main/master
//
// Inputs are Zod-validated. buildArgs translates validated inputs into an
// explicit string[]. No shell strings are ever constructed from frontend
// data.

import { z } from 'zod';
import type { AdminControl, AdminControlPublic } from './types';

const noInputs = z.object({}).strict();

// `--base <ref>` is the only optional flag exposed by the review-report /
// diff-summary controls. We constrain it to a safe ref pattern. The string
// is passed as a SEPARATE argv element to spawn (never interpolated).
const refSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._\-\/]+$/, 'ref must be alphanumeric, ., _, -, /');

const reviewInputs = z
  .object({
    base: refSchema.optional()
  })
  .strict();

// The review-report script also supports --output <path>. The foundation
// REFUSES to expose --output through the registry because that would allow
// a client to influence a filesystem path. Reports always land under
// docs/reports/ via the script's own default behavior.

export const FORGE_CONTROLS: ReadonlyArray<AdminControl> = [
  // ---------- system-health ----------
  {
    id: 'config-validate',
    label: 'Validate App Config',
    description: 'Runs w3-app-config-validate.sh for the active app. Read-only.',
    category: 'system-health',
    scriptName: 'w3-app-config-validate.sh',
    riskLevel: 'LOW',
    runStrategy: 'safe-direct',
    readOnly: true,
    timeoutSeconds: 30,
    inputSchema: noInputs,
    buildArgs: () => []
  },
  {
    id: 'branch-check',
    label: 'Branch Check',
    description:
      'Confirms current branch matches allowed_branch_pattern and is not blocked.',
    category: 'system-health',
    scriptName: 'w3-app-branch-check.sh',
    riskLevel: 'LOW',
    runStrategy: 'safe-direct',
    readOnly: true,
    timeoutSeconds: 15,
    inputSchema: noInputs,
    buildArgs: () => []
  },
  {
    id: 'git-status',
    label: 'Git Status',
    description: 'Reports working-tree status for the configured workspace.',
    category: 'system-health',
    scriptName: 'w3-app-git-status.sh',
    riskLevel: 'LOW',
    runStrategy: 'safe-direct',
    readOnly: true,
    timeoutSeconds: 15,
    inputSchema: noInputs,
    buildArgs: () => []
  },
  {
    id: 'app-status',
    label: 'App Status',
    description: 'Quick health and metadata snapshot for the app.',
    category: 'system-health',
    scriptName: 'w3-app-status.sh',
    riskLevel: 'LOW',
    runStrategy: 'safe-direct',
    readOnly: true,
    timeoutSeconds: 30,
    inputSchema: noInputs,
    buildArgs: () => []
  },
  {
    id: 'local-model-test',
    label: 'Local Model Test',
    description: 'Checks for a local Ollama runtime when require_local_model is set.',
    category: 'system-health',
    scriptName: 'w3-app-local-model-test.sh',
    riskLevel: 'LOW',
    runStrategy: 'safe-direct',
    readOnly: true,
    timeoutSeconds: 60,
    inputSchema: noInputs,
    buildArgs: () => []
  },

  // ---------- inspect-test ----------
  {
    id: 'inspect',
    label: 'Inspect',
    description: 'Read-only inspection of the configured workspace.',
    category: 'inspect-test',
    scriptName: 'w3-app-inspect.sh',
    riskLevel: 'LOW',
    runStrategy: 'safe-direct',
    readOnly: true,
    timeoutSeconds: 60,
    inputSchema: noInputs,
    buildArgs: () => []
  },
  {
    id: 'test',
    label: 'Run Configured Tests',
    description: 'Runs the tests.commands list from the app config. No production effects.',
    category: 'inspect-test',
    scriptName: 'w3-app-test.sh',
    riskLevel: 'LOW',
    runStrategy: 'safe-direct',
    readOnly: true,
    timeoutSeconds: 180,
    inputSchema: noInputs,
    buildArgs: () => []
  },

  // ---------- workflow ----------
  {
    id: 'workflow-status',
    label: 'Workflow Status',
    description: 'Aggregates config-validate, branch-check, model-test, and test into READY/WARN/ERROR.',
    category: 'workflow',
    scriptName: 'w3-app-workflow-status.sh',
    riskLevel: 'LOW',
    runStrategy: 'safe-direct',
    readOnly: true,
    timeoutSeconds: 240,
    inputSchema: noInputs,
    buildArgs: () => []
  },

  // ---------- review ----------
  {
    id: 'diff-summary',
    label: 'Diff Summary',
    description: 'Plain-text diff summary vs an optional base ref.',
    category: 'review',
    scriptName: 'w3-app-diff-summary.sh',
    riskLevel: 'LOW',
    runStrategy: 'safe-direct',
    readOnly: true,
    timeoutSeconds: 60,
    inputSchema: reviewInputs,
    buildArgs: (inputs: unknown) => {
      const parsed = reviewInputs.parse(inputs);
      return parsed.base ? ['--base', parsed.base] : [];
    }
  },
  {
    id: 'review-report',
    label: 'Review Report',
    description:
      'Generates a Markdown review report under docs/reports/. Report path is fixed by the script; cannot be influenced by the client.',
    category: 'review',
    scriptName: 'w3-app-review-report.sh',
    riskLevel: 'LOW',
    runStrategy: 'safe-direct',
    readOnly: true,
    timeoutSeconds: 120,
    inputSchema: reviewInputs,
    buildArgs: (inputs: unknown) => {
      const parsed = reviewInputs.parse(inputs);
      return parsed.base ? ['--base', parsed.base] : [];
    }
  },
  {
    id: 'review-ready',
    label: 'Review Ready',
    description: 'Aggregates workflow-status with review-report into a single READY/WARN/ERROR signal.',
    category: 'review',
    scriptName: 'w3-app-review-ready.sh',
    riskLevel: 'LOW',
    runStrategy: 'safe-direct',
    readOnly: true,
    timeoutSeconds: 300,
    inputSchema: reviewInputs,
    buildArgs: (inputs: unknown) => {
      const parsed = reviewInputs.parse(inputs);
      return parsed.base ? ['--base', parsed.base] : [];
    }
  }
];

const BY_ID = new Map<string, AdminControl>(FORGE_CONTROLS.map((c) => [c.id, c]));

export function getControl(id: string): AdminControl | undefined {
  return BY_ID.get(id);
}

export function listControlsPublic(): AdminControlPublic[] {
  return FORGE_CONTROLS.map((c) => {
    // Best-effort input-name list: iterate shape keys when the schema is a ZodObject.
    let inputs: string[] = [];
    const schema = c.inputSchema as unknown as { shape?: Record<string, unknown> };
    if (schema && typeof schema.shape === 'object' && schema.shape !== null) {
      inputs = Object.keys(schema.shape);
    }
    return {
      id: c.id,
      label: c.label,
      description: c.description,
      category: c.category,
      scriptName: c.scriptName,
      riskLevel: c.riskLevel,
      runStrategy: c.runStrategy,
      readOnly: c.readOnly,
      timeoutSeconds: c.timeoutSeconds,
      inputs
    };
  });
}
