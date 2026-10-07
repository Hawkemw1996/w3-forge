import type { Request } from 'express';

/**
 * Log registered route templates, never caller-supplied URLs/query values.
 * This also protects secrets mistakenly sent as a path parameter. Unmatched
 * requests deliberately have no raw path fallback. No authentication behavior
 * changes: tokens remain Authorization-header-only.
 */
export function requestPathForLog(req: Request): string {
  if (typeof req.route?.path !== 'string') return '[unmatched]';
  return `${req.baseUrl ?? ''}${req.route.path}`.split(/[?#]/, 1)[0];
}

/** Crash reasons/stacks can embed arbitrary credential-bearing URLs or input. */
export function safeErrorForLog(error: unknown): { type: string; details: string } {
  return { type: error instanceof Error ? 'Error' : 'Unknown', details: '[redacted]' };
}

/**
 * W3 Forge addition: structured diagnostics that are safe to log. Only
 * error class names and PostgreSQL schema identifiers (SQLSTATE, constraint,
 * table, column, routine) — never messages, values, SQL text, or parameters,
 * which can contain user input or credentials.
 */
export function errorDiagnosticsForLog(error: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!error || typeof error !== 'object') return out;
  const e = error as Record<string, unknown>;
  const ident = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(v) ? v : undefined);
  const name = error instanceof Error ? ident(error.name) : undefined;
  if (name) out.name = name;
  for (const k of ['code', 'constraint', 'table', 'column', 'routine', 'severity']) {
    const v = ident(e[k]);
    if (v) out[k === 'code' ? 'sqlstate' : k] = v;
  }
  return out;
}
