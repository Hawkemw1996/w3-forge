// =============================================================================
// Uniform ApiEnvelope<T> — every /api/admin/* response, success or failure.
// =============================================================================
//
// Routes MUST NOT call res.json(...) directly. They must go through
// respond.ok or respond.err so the wire shape is uniform on every code path,
// including thrown exceptions caught by the global error middleware.
//
// Success:
//   { success: true, data: T }
//
// Failure:
//   { success: false, error: { code, message, details? } }
//
// This is the v0.4.0 contract. Future versions may extend it (e.g. with a
// `requestId` field) but must keep these top-level keys stable.

import type { Request, Response, NextFunction } from 'express';

export interface ApiEnvelopeSuccess<T> {
  success: true;
  data: T;
}

export interface ApiEnvelopeFailure {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiEnvelope<T> = ApiEnvelopeSuccess<T> | ApiEnvelopeFailure;

export class AdminError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const respond = {
  ok<T>(res: Response, data: T): Response {
    const body: ApiEnvelopeSuccess<T> = { success: true, data };
    return res.status(200).json(body);
  },
  err(
    res: Response,
    status: number,
    code: string,
    message: string,
    details?: unknown
  ): Response {
    const body: ApiEnvelopeFailure = {
      success: false,
      error: details === undefined ? { code, message } : { code, message, details }
    };
    return res.status(status).json(body);
  }
};

// Global error middleware. Mounted LAST on the admin router so any thrown
// AdminError or unexpected exception is normalized to the envelope shape.
// Express's default HTML error page must never be reachable.
export function envelopeErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  if (err instanceof AdminError) {
    respond.err(res, err.status, err.code, err.message, err.details);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  respond.err(res, 500, 'INTERNAL_ERROR', message);
}

// 404 handler for any /api/admin/* path that no route matched. Mounted just
// before envelopeErrorHandler so unknown routes also return an envelope.
export function envelopeNotFound(_req: Request, res: Response): void {
  respond.err(res, 404, 'NOT_FOUND', 'Admin endpoint not found');
}
