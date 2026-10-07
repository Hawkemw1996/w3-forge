// =============================================================================
// W3 Core v0.5.13 — Admin Controls input + confirmation validator.
// =============================================================================
//
// Pure functions. No I/O. Used by both the /validate and /run endpoints.

import type {
  AdminControl,
  InputField,
  ValidateIssue,
  ValidateRequestBody,
  ValidateResponse
} from './types';
import { pipelineOverrideError } from './pipelineOverrides';

function checkInputField(
  field: InputField,
  value: unknown,
  issues: ValidateIssue[]
): unknown {
  if (value === undefined || value === null || value === '') {
    if (field.required) {
      issues.push({
        key: field.key,
        kind: 'missing',
        message: `Required input "${field.label}" is missing.`
      });
    }
    return value ?? null;
  }
  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string') {
        issues.push({
          key: field.key,
          kind: 'invalid',
          message: `Input "${field.label}" must be a string.`
        });
        return null;
      }
      if (field.minLength !== undefined && value.length < field.minLength) {
        issues.push({
          key: field.key,
          kind: 'invalid',
          message: `Input "${field.label}" must be at least ${field.minLength} characters.`
        });
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        issues.push({
          key: field.key,
          kind: 'invalid',
          message: `Input "${field.label}" must be at most ${field.maxLength} characters.`
        });
      }
      if (field.pattern) {
        try {
          const re = new RegExp(field.pattern);
          if (!re.test(value)) {
            issues.push({
              key: field.key,
              kind: 'invalid',
              message: `Input "${field.label}" does not match the required pattern.`
            });
          }
        } catch {
          // A bad registry regex is a server-side bug; surface it but don't crash.
          issues.push({
            key: field.key,
            kind: 'invalid',
            message: `Input "${field.label}" has an unparseable pattern in the registry.`
          });
        }
      }
      return value;
    }
    case 'select': {
      if (typeof value !== 'string') {
        issues.push({
          key: field.key,
          kind: 'invalid',
          message: `Input "${field.label}" must be a string value.`
        });
        return null;
      }
      // Dynamic option lists (packages.staged / backups.local) are resolved at
      // run-time and validated by the runner, not here. Static options can be
      // checked now.
      if (field.optionsSource === 'static' && field.staticOptions) {
        const ok = field.staticOptions.some((o) => o.value === value);
        if (!ok) {
          issues.push({
            key: field.key,
            kind: 'invalid',
            message: `Input "${field.label}" is not one of the allowed values.`
          });
        }
      }
      return value;
    }
    case 'checkbox': {
      const boolVal = value === true || value === 'true';
      if (field.mustBeTrue && !boolVal) {
        issues.push({
          key: field.key,
          kind: 'missing',
          message: `Checkbox "${field.label}" must be checked.`
        });
      }
      return boolVal;
    }
  }
}

export function validateControl(
  control: AdminControl,
  body: ValidateRequestBody
): ValidateResponse {
  const issues: ValidateIssue[] = [];
  const inputsEcho: Record<string, unknown> = {};
  const confirmationsEcho: Record<string, unknown> = {};

  // 1) hard "is this even runnable?" gates first.
  if (!control.enabled) {
    issues.push({
      key: '_enabled',
      kind: 'disabled',
      message: 'Control is disabled in the v0.5.13 registry.'
    });
  }
  if (control.runStrategy === 'disabled') {
    issues.push({
      key: '_strategy',
      kind: 'disabled',
      message: 'Run strategy is "disabled" — refused.'
    });
  }
  if (control.runStrategy === 'terminal-only') {
    issues.push({
      key: '_strategy',
      kind: 'unsafe',
      message: 'Control is TERMINAL_ONLY — must be run by an operator on the host.'
    });
  }
  if (control.runStrategy === 'wrapper') {
    issues.push({
      key: '_strategy',
      kind: 'unsafe',
      message:
        'Control NEEDS_WRAPPER — script lacks an installed non-interactive wrapper. UI execution is not wired yet.'
    });
  }
  // safe-direct and safe-wrapper are the two permitted UI execution paths.
  // safe-wrapper is permitted up to MEDIUM risk; HIGH/CRITICAL are blocked
  // here as a second line of defense (the runner re-checks).
  if (control.runStrategy === 'safe-wrapper') {
    if (control.riskLevel === 'HIGH' || control.riskLevel === 'CRITICAL') {
      issues.push({
        key: '_strategy',
        kind: 'unsafe',
        message:
          'HIGH/CRITICAL controls may not run on the safe-wrapper path. Wait for the v0.5.15+ runner.'
      });
    }
  }

  // 2) validate inputs.
  const inputs = body.inputs ?? {};
  if (control.runStrategy === 'safe-pipeline') {
    const overrideError = pipelineOverrideError(control.id, inputs);
    if (overrideError) issues.push({ key: '_overrides', kind: 'invalid', message: overrideError });
  }
  if (control.requiresInputs && control.inputSchema) {
    for (const field of control.inputSchema.fields) {
      inputsEcho[field.key] = checkInputField(field, inputs[field.key], issues);
    }
  }

  // 3) validate confirmations.
  const confirmations = body.confirmations ?? {};
  if (control.requiresConfirmation && control.confirmationSchema) {
    for (const cb of control.confirmationSchema.checkboxes) {
      const v = confirmations[cb.key];
      const boolVal = v === true || v === 'true';
      confirmationsEcho[cb.key] = boolVal;
      if (cb.mustBeTrue && !boolVal) {
        issues.push({
          key: cb.key,
          kind: 'missing',
          message: `Confirmation "${cb.label}" must be checked.`
        });
      }
    }
    for (const phrase of control.confirmationSchema.typedPhrases) {
      const v = confirmations[phrase.key];
      const s = typeof v === 'string' ? v : '';
      confirmationsEcho[phrase.key] = s;
      if (s !== phrase.expected) {
        issues.push({
          key: phrase.key,
          kind: 'mismatch',
          message: `Typed phrase for "${phrase.label}" must equal "${phrase.expected}".`
        });
      }
    }
  }

  const runnable = issues.length === 0;
  return {
    controlId: control.id,
    enabled: control.enabled,
    status: control.status,
    riskLevel: control.riskLevel,
    runnable,
    issues,
    echo: {
      inputs: inputsEcho,
      confirmations: confirmationsEcho
    }
  };
}
