import { Router, type RequestHandler, type Request, type Response } from 'express';
import { respond } from '../envelope';
import type { TerminalRuntime } from '../terminal/runtime';
import { TerminalError, type TerminalIdentity, type TerminalSize } from '../terminal/sessionManager';

function identity(req: Request, res: Response, runtime: TerminalRuntime): TerminalIdentity {
  const user = res.locals.coreUser;
  const session = runtime.identity(req);
  if (!user || !session || user.id !== session.userId) {
    throw new TerminalError(401, 'AUTH_REQUIRED', 'Sign in with W3 Core to open a terminal.');
  }
  return session;
}

function size(body: unknown): TerminalSize {
  const input = body as Partial<TerminalSize> | undefined;
  if (!input || !Number.isInteger(input.cols) || !Number.isInteger(input.rows)
    || input.cols! < 10 || input.cols! > 500 || input.rows! < 2 || input.rows! > 200) {
    throw new TerminalError(400, 'TERMINAL_SIZE_INVALID', 'Terminal dimensions must be 10–500 columns and 2–200 rows.');
  }
  return { cols: input.cols!, rows: input.rows! };
}

// Protect reads as well as writes: output is sensitive and requires an explicit
// same-site terminal client. The parent router also checks IP, Core admin and JSON.
const terminalRequestGuard = (configuredOrigin: string): RequestHandler => (req, res, next) => {
  const deny = () => respond.err(res, 403, 'TERMINAL_ORIGIN_DENIED', 'Open Terminal from the Admin Console on this site.');
  if (req.get('X-W3-Terminal') !== '1') { deny(); return; }
  const site = req.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') { deny(); return; }
  const origin = req.get('Origin');
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin
        || (configuredOrigin ? parsed.origin !== new URL(configuredOrigin).origin : parsed.host !== req.get('host'))) { deny(); return; }
    } catch { deny(); return; }
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/** Human-admin terminal only. Automated controls continue to use safeRunner. */
export function buildAdminTerminalRoutes(runtime: TerminalRuntime): Router {
  const router = Router();
  router.use('/terminal', terminalRequestGuard(runtime.origin));
  const handle = (fn: RequestHandler): RequestHandler => (req, res, next) => {
    Promise.resolve().then(() => fn(req, res, next)).catch(error => {
      if (error instanceof TerminalError) {
        if (!res.headersSent && !res.destroyed) respond.err(res, error.status, error.code, error.message);
      } else next(error);
    });
  };
  router.get('/terminal/status', handle((_req, res) => { respond.ok(res, runtime.status()); }));
  router.post('/terminal/sessions', handle(async (req, res) => {
    const status = runtime.status();
    if (!status.available) throw new TerminalError(503, 'TERMINAL_UNAVAILABLE', status.message);
    const owner = identity(req, res, runtime);
    if (!await runtime.authorize(owner)) throw new TerminalError(401, 'TERMINAL_AUTH_EXPIRED', 'Sign in again to open a terminal.');
    const session = runtime.manager.create(owner, size(req.body));
    respond.ok(res, { ...session, hostname: status.hostname, access: status.access });
  }));
  router.get('/terminal/sessions/:id/output', handle(async (req, res) => {
    if (typeof req.query.cursor !== 'string' || !/^\d{1,16}$/.test(req.query.cursor)) throw new TerminalError(400, 'TERMINAL_CURSOR_INVALID', 'A valid output cursor is required.');
    const abort = new AbortController();
    const close = () => { abort.abort(); };
    res.once('close', close);
    try {
      const data = await runtime.manager.read(String(req.params.id), identity(req, res, runtime), Number(req.query.cursor), abort.signal);
      if (!res.destroyed) respond.ok(res, data);
    } finally { res.removeListener('close', close); }
  }));
  router.post('/terminal/sessions/:id/input', handle((req, res) => {
    if (typeof req.body?.data !== 'string' || !req.body.data.length || req.body.data.length > 8192) throw new TerminalError(400, 'TERMINAL_INPUT_INVALID', 'Input must contain 1–8192 characters.');
    runtime.manager.write(String(req.params.id), identity(req, res, runtime), req.body.data);
    respond.ok(res, { accepted: true });
  }));
  router.post('/terminal/sessions/:id/resize', handle((req, res) => {
    runtime.manager.resize(String(req.params.id), identity(req, res, runtime), size(req.body));
    respond.ok(res, { resized: true });
  }));
  router.post('/terminal/sessions/:id/close', handle((req, res) => {
    runtime.manager.close(String(req.params.id), identity(req, res, runtime));
    respond.ok(res, { closed: true });
  }));
  return router;
}
