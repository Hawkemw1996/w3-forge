import { Router, type Request, type Response } from 'express';
import type { Database } from '../db/database';
import { AdminError, respond } from '../admin/envelope';
import { createFactoryService } from './service';
import type { FactoryActor } from './types';

// The containing engineering-workspace router supplies current Core admin
// authorization and same-origin JSON enforcement before mounting these routes.
export function buildFactoryRouter(db: Database, options: { draftPlan?: (model: string, prompt: string) => Promise<string> } = {}) {
  const router = Router();
  const service = createFactoryService(db);
  function actor(req: Request): FactoryActor {
    const user = (req as Request & { forgeUser?: { coreUserId: string; displayName?: string; username?: string } }).forgeUser;
    if (!user?.coreUserId) throw new AdminError(401, 'AUTH_REQUIRED', 'Sign in to the engineering workspace.');
    return { coreUserId: user.coreUserId, name: user.displayName || user.username || user.coreUserId };
  }
  const handle = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { respond.ok(res, await fn(req)); }
    catch (error) {
      if (error instanceof AdminError) { respond.err(res,error.status,error.code,error.message,error.details); return; }
      respond.err(res,503,'FACTORY_UNAVAILABLE','The Software Factory database is unavailable or its setup is incomplete. Ask an administrator to check the Forge database and migrations.');
    }
  };
  const id = (req: Request) => { const value = String(req.params.id ?? ''); if (!/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw new AdminError(400,'INVALID_FACTORY_ID','Invalid factory record identifier.'); return value; };
  router.get('/',handle(req=>service.snapshot(actor(req))));
  router.post('/projects',handle(req=>service.createProject(actor(req),req.body)));
  router.post('/projects/:id/rules',handle(req=>service.updateRules(actor(req),id(req),req.body)));
  router.get('/projects/:id/rules',handle(req=>{actor(req);return service.listRules(id(req));}));
  router.post('/requests',handle(req=>service.createRequest(actor(req),req.body)));
  router.get('/requests/:id/prompt',handle(req=>{actor(req);return service.prompt(id(req));}));
  router.post('/requests/:id/action',handle(req=>service.action(actor(req),id(req),req.body)));
  router.post('/requests/:id/draft-plan',handle(req=>{const current=actor(req);if(!options.draftPlan) throw new AdminError(503,'PLAN_SERVICE_UNAVAILABLE','An available Ollama model is required to draft a plan.');return service.draftPlan(current,id(req),req.body,options.draftPlan);}));
  router.post('/notifications/:id/read',handle(req=>service.readNotification(actor(req),id(req))));
  return router;
}
