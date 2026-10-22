import { Router, type Request, type Response } from 'express';
import type { Database } from '../db/database';
import type { AuditActor } from '../db/audit';
import { AdminError, respond } from '../admin/envelope';
import { createAgentService } from './service';
import type { AgentServiceOptions } from './types';

// Mounted only inside the existing Core-admin, same-origin workspace boundary.
export function buildAgentRouter(db: Database, options: AgentServiceOptions = {}) {
  const router=Router(), service=createAgentService(db,options);
  function actor(req: Request): AuditActor {
    const user=req.forgeUser;
    if(!user?.coreUserId) throw new AdminError(401,'AUTH_REQUIRED','Sign in to the engineering workspace.');
    return {coreUserId:user.coreUserId,name:user.displayName||user.username||user.coreUserId};
  }
  const id=(req: Request)=>{const value=String(req.params.id??'');if(!/^[a-zA-Z0-9-]{1,80}$/.test(value))throw new AdminError(400,'INVALID_AGENT_ID','Invalid agent identifier.');return value;};
  const handle=(fn:(req:Request)=>Promise<unknown>)=>async(req:Request,res:Response)=>{
    try {respond.ok(res,await fn(req));}
    catch(error) {if(error instanceof AdminError){respond.err(res,error.status,error.code,error.message,error.details);return;}respond.err(res,503,'AGENTS_UNAVAILABLE','Agent profiles are unavailable. Ask an administrator to check the Forge database and migrations.');}
  };
  router.get('/',handle(req=>{actor(req);return service.list();}));
  router.post('/',handle(req=>service.create(actor(req),req.body)));
  router.get('/:id/history',handle(req=>{actor(req);return service.history(id(req));}));
  router.post('/:id/profile',handle(req=>service.updateProfile(actor(req),id(req),req.body)));
  router.post('/:id/assignment',handle(req=>service.assign(actor(req),id(req),req.body)));
  router.post('/:id/status',handle(req=>service.status(actor(req),id(req),req.body)));
  router.post('/:id/delete',handle(req=>service.delete(actor(req),id(req),req.body)));
  router.post('/:id/duplicate',handle(req=>service.duplicate(actor(req),id(req),req.body)));
  return router;
}
