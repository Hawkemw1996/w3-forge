// =============================================================================
// adminAudit — append-only JSONL log of every /api/admin/* request.
// =============================================================================
//
// Adapted from W3 Core. Logs the resolved status code AND the envelope
// error.code on failures (v0.4.0 requirement). The audit log lives at the
// path configured by admin_console.audit_log; falls back to W3_FORGE_ADMIN_AUDIT
// env or logs/admin/audit.jsonl under FORGE_ROOT.

import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { FORGE_ROOT } from './forgeConfig';

function defaultAuditPath(): string {
  const env = (process.env.W3_FORGE_ADMIN_AUDIT ?? '').trim();
  if (env) return env;
  return path.join(FORGE_ROOT, 'logs', 'admin', 'audit.jsonl');
}

function ensureDir(filePath: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    // Best-effort. If we can't make the dir we still try the write, which
    // will surface as a thrown error in the audit append.
  }
}

interface CapturedBody {
  errorCode?: string;
}

function captureEnvelopeOnSend(res: Response): { get(): CapturedBody } {
  const captured: CapturedBody = {};
  const origJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (
      body &&
      typeof body === 'object' &&
      'success' in (body as Record<string, unknown>) &&
      (body as { success?: boolean }).success === false
    ) {
      const err = (body as { error?: { code?: string } }).error;
      if (err && typeof err.code === 'string') captured.errorCode = err.code;
    }
    return origJson(body);
  };
  return { get: () => captured };
}

export function adminAudit(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const auditPath = defaultAuditPath();
  ensureDir(auditPath);

  const capture = captureEnvelopeOnSend(res);

  res.on('finish', () => {
    const entry = {
      ts: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      remote: req.ip ?? null,
      status: res.statusCode,
      error_code: capture.get().errorCode ?? null,
      duration_ms: Date.now() - start
    };
    try {
      fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // Audit logging must never crash the request path.
    }
  });

  next();
}
