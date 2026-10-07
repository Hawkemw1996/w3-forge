import { Router, Request, RequestHandler } from 'express';
import type { TerminalRuntime } from '../terminal/runtime';
import { TerminalError, TerminalIdentity, TerminalSize } from '../terminal/sessionManager';

function identity(req: Request, runtime: TerminalRuntime): TerminalIdentity {
  const user = req.forgeUser;
  const session = runtime.identity(req);
  if (!user || !session || user.coreUserId !== session.userId) throw new TerminalError(401, 'AUTH_REQUIRED', 'Sign in to open a terminal.');
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

// Custom header prevents simple form requests; Origin checks still apply if CORS is relaxed.
const terminalRequestGuard = (configuredOrigin: string): RequestHandler => (req, res, next) => {
  const deny = () => res.status(403).json({ success: false, error: { code: 'TERMINAL_ORIGIN_DENIED', message: 'Open Terminal from the Admin Console on this site.' } });
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
  if (req.method === 'POST' && !req.is('application/json')) {
    res.status(415).json({ success: false, error: { code: 'TERMINAL_JSON_REQUIRED', message: 'A JSON request is required.' } });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/** Mounted only under the existing network + active admin-human middleware stack. */
export function buildAdminTerminalRoutes(terminalRuntime: TerminalRuntime): Router {
  const router = Router();
  router.use('/terminal', terminalRequestGuard(terminalRuntime.origin));
  const handle = (fn: RequestHandler): RequestHandler => (req, res, next) => {
    Promise.resolve().then(() => fn(req, res, next)).catch(error => {
      if (error instanceof TerminalError) {
        if (!res.headersSent && !res.destroyed) res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
      } else next(error);
    });
  };
  router.get('/terminal/status', handle((_req, res) => { res.json({ success: true, data: terminalRuntime.status() }); }));
  router.post('/terminal/sessions', handle(async (req, res) => {
    const status = terminalRuntime.status();
    if (!status.available) throw new TerminalError(503, 'TERMINAL_UNAVAILABLE', status.message);
    const owner = identity(req, terminalRuntime);
    if (!await terminalRuntime.authorize(owner)) throw new TerminalError(401, 'TERMINAL_AUTH_EXPIRED', 'Sign in again to open a terminal.');
    const session = terminalRuntime.manager.create(owner, size(req.body));
    res.status(201).json({ success: true, data: { ...session, hostname: status.hostname, access: status.access } });
  }));
  router.get('/terminal/sessions/:id/output', handle(async (req, res) => {
    if (typeof req.query.cursor !== 'string' || !/^\d{1,16}$/.test(req.query.cursor)) throw new TerminalError(400, 'TERMINAL_CURSOR_INVALID', 'A valid output cursor is required.');
    const abort = new AbortController();
    const close = () => { abort.abort(); };
    res.once('close', close);
    try {
      const data = await terminalRuntime.manager.read(String(req.params.id), identity(req, terminalRuntime), Number(req.query.cursor), abort.signal);
      if (!res.destroyed) res.json({ success: true, data });
    } finally { res.removeListener('close', close); }
  }));
  router.post('/terminal/sessions/:id/input', handle((req, res) => {
    if (typeof req.body?.data !== 'string' || !req.body.data.length || req.body.data.length > 8192) throw new TerminalError(400, 'TERMINAL_INPUT_INVALID', 'Input must contain 1–8192 characters.');
    terminalRuntime.manager.write(String(req.params.id), identity(req, terminalRuntime), req.body.data);
    res.json({ success: true, data: { accepted: true } });
  }));
  router.post('/terminal/sessions/:id/resize', handle((req, res) => {
    terminalRuntime.manager.resize(String(req.params.id), identity(req, terminalRuntime), size(req.body));
    res.json({ success: true, data: { resized: true } });
  }));
  router.post('/terminal/sessions/:id/close', handle((req, res) => {
    terminalRuntime.manager.close(String(req.params.id), identity(req, terminalRuntime));
    res.json({ success: true, data: { closed: true } });
  }));
  return router;
}
