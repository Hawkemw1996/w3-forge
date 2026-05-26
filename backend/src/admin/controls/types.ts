// =============================================================================
// Forge control types — v0.4.0 foundation.
// =============================================================================
//
// Every Forge control:
//   - has riskLevel LOW
//   - has runStrategy 'safe-direct'
//   - is readOnly: true
//   - maps to exactly one script under ${W3_FORGE_ROOT}/scripts
//   - always passes --app <app_id>
//
// Inputs are typed and validated server-side via a per-control Zod schema.
// The buildArgs function turns validated inputs into an explicit string[]
// of CLI flags. There is no path from a frontend body to a shell string.

import type { z, ZodTypeAny } from 'zod';

export type RiskLevel = 'LOW';
export type RunStrategy = 'safe-direct';
export type ControlCategory =
  | 'workflow'
  | 'review'
  | 'inspect-test'
  | 'system-health';

export interface AdminControl {
  id: string;
  label: string;
  description: string;
  category: ControlCategory;
  scriptName: string; // e.g. 'w3-app-workflow-status.sh'
  riskLevel: RiskLevel;
  runStrategy: RunStrategy;
  readOnly: true;
  timeoutSeconds: number;
  inputSchema: ZodTypeAny;
  // Produces the additional CLI args (AFTER --app <appId>) from validated
  // inputs. Must return string[] only — never a single shell string.
  buildArgs: (inputs: unknown) => string[];
}

// Public-shape returned by GET /controls. Hides the buildArgs function and
// the raw Zod schema; ships a JSON-friendly inputSchemaShape stub instead.
export interface AdminControlPublic {
  id: string;
  label: string;
  description: string;
  category: ControlCategory;
  scriptName: string;
  riskLevel: RiskLevel;
  runStrategy: RunStrategy;
  readOnly: true;
  timeoutSeconds: number;
  inputs: string[]; // names of accepted inputs (for UI)
}

export interface ControlRunResult {
  controlId: string;
  appId: string;
  scriptName: string;
  args: string[];
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ControlInputs<T extends ZodTypeAny> = z.infer<T>;
