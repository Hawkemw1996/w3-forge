import { Router, type Request, type Response } from 'express';
import { AdminError, respond } from '../admin/envelope';
import type { ExecutionEngine } from './engine';
export function buildExecutionRouter(engine: ExecutionEngine) {
    const router = Router();
    const actor = (req: Request) => {
        const u = req.forgeUser;
        if (!u?.coreUserId)
            throw new AdminError(401, 'AUTH_REQUIRED', 'Sign in to the engineering workspace.');
        return { coreUserId: u.coreUserId, name: u.displayName || u.username || u.coreUserId };
    };
    const id = (req: Request) => {
        const v = String(req.params.id ?? '');
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(v))
            throw new AdminError(400, 'INVALID_EXECUTION_ID', 'Invalid execution identifier.');
        return v;
    };
    const revision = (req: Request) => {
        const b = req.body;
        if (!b || Array.isArray(b) || typeof b !== 'object' || Object.keys(b).length !== 1 || !Number.isInteger(b.expectedRevision) || b.expectedRevision < 1 || b.expectedRevision > 2147483647)
            throw new AdminError(400, 'INVALID_EXECUTION_ACTION', 'Supply the current expectedRevision only.');
        return b.expectedRevision as number;
    };
    const handle = (fn: (req: Request) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
        try {
            actor(req);
            respond.ok(res, await fn(req));
        }
        catch (e) {
            if (e instanceof AdminError)
                respond.err(res, e.status, e.code, e.message, e.details);
            else
                respond.err(res, 503, 'EXECUTION_UNAVAILABLE', 'Execution storage is unavailable. Check the Forge database and migrations.');
        }
    };
    router.get('/status', handle(() => engine.status()));
    router.get('/requests/:id/jobs', handle(async (req) => ({ jobs: await engine.store.list(id(req)) })));
    router.post('/requests/:id/start', handle(async (req) => {
        const n = revision(req);
        if (!engine.status().available)
            throw new AdminError(503, 'EXECUTION_NOT_CONFIGURED', engine.status().message);
        const job = await engine.store.start(actor(req), id(req), n);
        void engine.tick();
        return job;
    }));
    router.get('/jobs/:id', handle(req => engine.store.get(id(req))));
    router.get('/jobs/:id/events', handle(async (req) => ({ events: await engine.store.events(id(req)) })));
    router.post('/jobs/:id/approve', handle(async (req) => { const job = await engine.store.approve(actor(req), id(req), revision(req)); void engine.tick(); return job; }));
    router.post('/jobs/:id/cancel', handle(req => engine.store.cancel(actor(req), id(req), revision(req))));
    router.post('/jobs/:id/retry', handle(async (req) => {
        if (!engine.status().available)
            throw new AdminError(503, 'EXECUTION_NOT_CONFIGURED', engine.status().message);
        const job = await engine.store.retry(actor(req), id(req), revision(req));
        void engine.tick();
        return job;
    }));
    return router;
}
