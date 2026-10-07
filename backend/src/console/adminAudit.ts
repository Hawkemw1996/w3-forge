import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { requestPathForLog } from '../security/safeLogging';

// =============================================================================
// Admin audit logging middleware.
// =============================================================================
//
// Every request to /api/admin/* is appended to /opt/logs/w3forge/admin/ as a
// single line: timestamp, method, path, status code, duration, client IP,
// guard reason. Lines are JSON-encoded so they're easy to consume from the
// logs-w3forge.sh viewer or from a future SSE/live-logs page. Write failures
// are intentionally swallowed — admin auditing must never break a request.
//
// A4 — Path is now sourced from env.adminLogDir (which reads ADMIN_LOG_DIR)
// rather than reading process.env directly, so the admin audit directory
// flows through the centralized env contract.

function logDir(): string {
  return env.adminLogDir;
}

let warned = false;
async function appendLine(line: string) {
  const dir = logDir();
  const file = path.join(dir, `admin-${new Date().toISOString().slice(0, 10)}.log`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(file, line + '\n', 'utf8');
  } catch (err) {
    if (!warned) {
      warned = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[admin-audit] could not write to ${file}: ${(err as Error).message}. ` +
          `Subsequent failures will be silently swallowed.`
      );
    }
  }
}

// =============================================================================
// v0.5.14 — structured per-control-run audit log.
// =============================================================================
//
// Every attempted Admin Controls /run gets one JSON line appended to
// /opt/logs/w3forge/admin/controls-run-<YYYY-MM-DD>.log, regardless of whether
// the call was admitted, refused by the validator, refused by the risk fence,
// refused by the action lock, or executed and returned. The line is small,
// JSON-shaped, and intentionally contains no script stdout/stderr — those
// live in the per-category log dirs already written by the scripts themselves.
//
// Operators can `tail -f /opt/logs/w3forge/admin/controls-run-*.log` to watch
// every Admin Controls execution attempt in real time.
//
// Write failures are swallowed (admin auditing must never break a request).

let runWarned = false;
async function appendRunLine(line: string) {
  const dir = logDir();
  const file = path.join(dir, `controls-run-${new Date().toISOString().slice(0, 10)}.log`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(file, line + '\n', 'utf8');
  } catch (err) {
    if (!runWarned) {
      runWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[admin-audit:controls-run] could not write to ${file}: ${(err as Error).message}. ` +
          `Subsequent failures will be silently swallowed.`
      );
    }
  }
}

export interface ControlRunAuditEntry {
  controlId: string;
  phase: 'refused' | 'admitted' | 'completed';
  outcome: string;                       // RunStatus value (e.g. 'success', 'failed', 'already_running')
  requestId?: string;
  reason?: string;
  exitCode?: number;
  durationMs?: number;
  riskLevel?: string;
  runStrategy?: string;
  enabled?: boolean;
  effectiveStatus?: string;
  lockHeldBy?: unknown;
  adminMode?: string;
  ip?: string | null;
}

export function appendControlRunAudit(entry: ControlRunAuditEntry): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    kind: 'control-run',
    ...entry
  });
  void appendRunLine(line);
}

/** Lifecycle only: never record terminal input, output, cookies or hashes. */
export function appendTerminalAudit(entry: { sessionId: string; userId: string; phase: 'opened' | 'closed'; reason?: string }): void {
  void appendLine(JSON.stringify({ ts: new Date().toISOString(), kind: 'terminal-session', ...entry }));
}

export function adminAudit(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const entry = {
      ts: new Date().toISOString(),
      method: req.method,
      path: requestPathForLog(req),
      status: res.statusCode,
      duration_ms: Number(durMs.toFixed(2)),
      ip: req.ip || req.socket.remoteAddress || null,
      admin_mode: req.adminAuth?.mode ?? 'unknown',
      guard_reason: req.adminAuth?.reason ?? 'denied'
    };
    void appendLine(JSON.stringify(entry));
  });
  next();
}
